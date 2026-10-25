/**
 * dsh-chat-manage — Host-side session housekeeping.
 *
 * DeepSeek Harness can archive a conversation but ships no surface for reading
 * the archive set back, for removing one entry from it, or for deleting a
 * conversation at all: `workspaceRegistry` exposes `archiveSession` and
 * `unarchiveSession`, `SessionPersistence` exposes `create`/`open`/`append`, and
 * neither has a delete. That is deliberate upstream — a stored log is the source
 * of truth and there is no rewrite path — but it leaves the archive set as a
 * one-way door for the user.
 *
 * This module is the missing maintenance layer. It reads the archive set and the
 * session headers through the official services, and it deletes in one order
 * only — artifact first, accounting last:
 *
 *   1. refuse while the session reports running work,
 *   2. remove what the filesystem actually holds and verify it is gone,
 *   3. drop the pin and any archive entry the user had set,
 *   4. make the row stop being listed: evict the resident session from the
 *      store, and archive whatever still reports the id,
 *   5. give up the workspace slot, last, so the sidebar never renders the id as
 *      an unaccounted row.
 *
 * Steps 2 and 4 are the difference between a delete and a ghost. `session.list`
 * is the union of the persisted records with the *live* sessions, and the store
 * keeps a session object until the process ends, so removing the log alone leaves
 * the row on screen. Worse, the JSONL backend's `list()` also yields
 * `tracker.pendingEntries()` — sessions created in this process that never
 * reached disk. They have no artifact at all, so `rm` removes nothing while
 * `stat()` still reports a header, which is how a delete can report success and
 * change nothing. Hence: delete by what exists, then make sure nothing still
 * lists the id — evicting the session when it is resident, archiving it when the
 * backend keeps counting it, and recording that in a tombstone file so a later
 * sweep can drop the archive entry once the id is really gone.
 *
 * Everything is addressed by the session id; nothing here guesses at paths when
 * the backend can name them itself.
 *
 * Only `node:` builtins are imported, so this file loads with or without the
 * Harness packages present and can be unit-tested from plain Node.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Event carrying the model-authored or fallback title of a conversation. */
const TITLE_EVENT = 'session/title'

/** First message of a conversation; the fallback title source. */
const USER_EVENT = 'user/message'

/** How much of one preview is rendered when the caller names no limit. */
export const DEFAULT_TRANSCRIPT_BLOCKS = 600

/** Upper bound on one request's ids, so a bad body cannot start a marathon. */
export const MAX_BATCH = 200

/** Truncation applied to one text block before it reaches the browser. */
const BLOCK_TEXT_LIMIT = 20_000

/** Truncation applied to one tool call's argument hint. */
const TOOL_HINT_LIMIT = 160

/**
 * The DSH home the Host runs from. `$DSH_HOME` wins because the persistence
 * backend may be pointed somewhere else entirely, and the profile is free to
 * move the whole tree.
 * @returns the resolved home directory.
 */
function dshHome() {
  const fromEnv = process.env?.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** Folder under the DSH home that holds this plugin's own bookkeeping. */
const STATE_DIR = 'chat-manage'

/** File holding the ids this plugin archived only to hide a log it deleted. */
const TOMBSTONE_FILE = 'tombstones.json'

/**
 * Where the tombstone set lives by default.
 * @returns an absolute path under the DSH home.
 */
function defaultTombstonePath() {
  return join(dshHome(), STATE_DIR, TOMBSTONE_FILE)
}

/**
 * Read the tombstone set.
 *
 * A missing or unreadable file means "no tombstones": this is bookkeeping that
 * may only ever shrink a hidden set, so failing open is safe and failing the
 * caller over a stray byte is not.
 * @param path - the tombstone file.
 * @returns the ids, never null.
 */
async function readTombstones(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return new Set()
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Set()
  }
  const ids = Array.isArray(parsed?.ids) ? parsed.ids : []
  return new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))
}

/**
 * Replace the tombstone set, atomically and without ever throwing.
 * @param path - the tombstone file.
 * @param ids - the ids to keep.
 */
async function writeTombstones(path, ids) {
  try {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.tmp`
    await writeFile(temporary, `${JSON.stringify({ ids: [...ids] }, null, 2)}\n`, 'utf8')
    await rename(temporary, path)
  } catch {
    /* the delete itself already succeeded; losing the sweep hint is not fatal */
  }
}

/**
 * Describe a thrown value as one line safe to put in a JSON response.
 * @param error - whatever was thrown.
 * @returns the message, never empty.
 */
export function describeError(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  if (typeof error === 'object' && typeof error.message === 'string' && error.message.length > 0) return error.message
  try {
    return JSON.stringify(error).slice(0, 300)
  } catch {
    return String(error)
  }
}

/**
 * Clamp one array of ids to something a single request may act on.
 * @param value - the untrusted body field.
 * @returns deduplicated, non-empty, bounded strings.
 */
export function normalizeIds(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    if (seen.size >= MAX_BATCH) break
  }
  return [...seen]
}

/**
 * Split one message's content parts into text and image placeholders.
 *
 * `reasoning` parts are dropped: an archived preview is there to answer "which
 * conversation was this", and the model's private deliberation is not part of
 * what the user wrote or read. Tool calls travel through their own events, so
 * the `tool-call` parts an assistant message repeats are skipped as well.
 *
 * @param content - the `content` array of a user or assistant message.
 * @returns the joined text plus how many images were elided.
 */
export function describeContent(content) {
  if (!Array.isArray(content)) return { text: '', images: 0 }
  const parts = []
  let images = 0
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    switch (part.type) {
      case 'text':
        if (typeof part.text === 'string' && part.text.trim().length > 0) parts.push(part.text)
        break
      case 'image':
        images += 1
        break
      default:
        break
    }
  }
  return { text: parts.join('\n').trim(), images }
}

/**
 * The argument hint printed next to one tool call.
 *
 * A tool call's `arguments` is a JSON string written by the model, so it is
 * parsed defensively: the useful field differs per tool (`description`,
 * `command`, `path`, `query`…), and an unparsable blob still deserves a short
 * quote rather than nothing.
 * @param raw - the `arguments` string of one `tool/call` event.
 * @returns one line, already truncated.
 */
export function toolHint(raw) {
  const source = typeof raw === 'string' ? raw : ''
  if (source.trim().length === 0) return ''
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    return clip(source, TOOL_HINT_LIMIT)
  }
  if (parsed === null || typeof parsed !== 'object') return clip(source, TOOL_HINT_LIMIT)
  for (const key of ['description', 'command', 'path', 'query', 'pattern', 'file_path', 'url']) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim().length > 0) return clip(value, TOOL_HINT_LIMIT)
  }
  return clip(source, TOOL_HINT_LIMIT)
}

/**
 * Cut one string to a readable length on a single line.
 * @param value - the raw text.
 * @param limit - maximum characters.
 * @returns the clipped text.
 */
export function clip(value, limit) {
  const flat = String(value).replace(/\s+/gu, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/**
 * Whether one `user/message` event is something the user actually typed.
 *
 * A session log also stores the context the Host injects before every request —
 * runtime policy snapshots, the skill catalog, time samples, subagent notices —
 * and it stores them as `user/message` events with a `source.kind` that names
 * the injector. Rendering those in a preview would bury the conversation under
 * its own scaffolding, so only `kind: "user"` (and a legacy event that predates
 * the field) counts as authored.
 * @param event - one stored event.
 * @returns whether the event carries user-authored content.
 */
export function isUserAuthored(event) {
  if (event?.type !== USER_EVENT) return false
  const kind = event?.data?.source?.kind
  return kind === undefined || kind === 'user'
}

/**
 * Read the title a stored log carries, newest event winning.
 *
 * The log is the only place a conversation's title lives: the persisted header
 * holds identity and cwd, never the visible name.
 * @param events - the stored events, in seq order.
 * @returns the last non-empty title, or undefined.
 */
export function titleOf(events) {
  let title
  for (const event of events) {
    if (event?.type !== TITLE_EVENT) continue
    const candidate = event?.data?.title
    if (typeof candidate === 'string' && candidate.trim().length > 0) title = candidate.trim()
  }
  return title
}

/**
 * The name to show for one log: its stored title, else the opening user line.
 *
 * A read window can end before the title event — a preview capped at a handful
 * of events, or a rename that landed late — and the persisted header carries no
 * title at all. Falling back to the first thing the user actually typed keeps the
 * header meaningful instead of blank.
 * @param events - the stored events, in seq order.
 * @returns the best available name, or '' when the window holds neither.
 */
export function displayTitle(events) {
  const titled = titleOf(events)
  if (titled !== undefined) return titled
  const firstUser = events.find((event) => isUserAuthored(event))
  if (firstUser === undefined) return ''
  return clip(describeContent(firstUser?.data?.content).text, 80)
}

/**
 * Fold one stored log into the blocks a preview renders.
 *
 * Only three kinds survive: what the user said, what the assistant answered, and
 * which tool ran in between. Step/turn/compaction bookkeeping is noise for the
 * question "what was this conversation about".
 * @param events - the stored events, in seq order.
 * @returns the blocks, in order, with empty assistant turns dropped.
 */
export function transcriptOf(events) {
  const blocks = []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const time = typeof event.time === 'number' ? event.time : undefined
    if (event.type === USER_EVENT) {
      if (!isUserAuthored(event)) continue
      const { text, images } = describeContent(event?.data?.content)
      if (text.length === 0 && images === 0) continue
      blocks.push({ kind: 'user', time, text: clipBlock(text), images })
      continue
    }
    if (event.type === 'assistant/message') {
      const { text } = describeContent(event?.data?.message?.content)
      if (text.length === 0) continue
      blocks.push({ kind: 'assistant', time, text: clipBlock(text) })
      continue
    }
    if (event.type === 'tool/call') {
      const name = typeof event?.data?.name === 'string' ? event.data.name : 'tool'
      blocks.push({ kind: 'tool', time, name, text: toolHint(event?.data?.arguments) })
    }
  }
  return blocks
}

/**
 * Cut one block's text without touching its surrounding whitespace rules.
 * @param value - the block text.
 * @returns the text, at most {@link BLOCK_TEXT_LIMIT} characters.
 */
function clipBlock(value) {
  if (value.length <= BLOCK_TEXT_LIMIT) return value
  return `${value.slice(0, BLOCK_TEXT_LIMIT)}\n\n… (${value.length - BLOCK_TEXT_LIMIT} more characters)`
}

/**
 * Build the maintenance facade over one Host context.
 *
 * @param ctx - the plugin context the routes run in; services are read lazily on
 *   every call so a replaced persistence backend or a reloaded registry is
 *   picked up without remounting this plugin.
 * @param options - tunables from the Loader row's config.
 * @returns the three operations the HTTP layer exposes.
 */
export function createSessionManager(ctx, options = {}) {
  const transcriptBlocks = positiveInt(options.transcriptBlocks, DEFAULT_TRANSCRIPT_BLOCKS)
  const cacheMs = positiveInt(options.listCacheSeconds, 15) * 1000
  const releaseWaitMs = positiveInt(options.releaseWaitMs, 2500)
  const tombstonePath = typeof options.tombstones === 'string' && options.tombstones.trim().length > 0
    ? options.tombstones.trim()
    : defaultTombstonePath()

  /** Per-session metadata memo, invalidated by the backend's own revision. */
  const cache = new Map()

  /** The three services this layer reads, all optional at the service level. */
  function services() {
    return {
      registry: ctx.get('workspaceRegistry'),
      persistence: ctx.get('sessionPersistence'),
      live: ctx.get('sessions'),
    }
  }

  /**
   * Read one stored log.
   * @param persistence - the persistence service.
   * @param id - the session to read.
   * @param limit - maximum events.
   * @returns the events, or undefined when the log cannot be interpreted.
   */
  async function readEvents(persistence, id, limit) {
    const handle = await persistence.open(id, 'read')
    try {
      const result = await handle.read(0, limit)
      return Array.isArray(result?.events) ? result.events : []
    } finally {
      try {
        handle.close()
      } catch {
        /* a handle whose fiber already unloaded is not an error here */
      }
    }
  }

  /**
   * Everything the archived list shows for one id.
   *
   * A row whose artifact is gone is still returned — the archive set can hold an
   * id whose file was deleted by hand or lost with a moved directory, and hiding
   * it would leave a ghost the user can never clear.
   * @param id - the session id.
   * @param persistence - the persistence service.
   * @returns the row.
   */
  async function describe(id, persistence) {
    let snapshot
    try {
      snapshot = await persistence.stat(id)
    } catch (error) {
      return { id, missing: true, unsupported: false, title: '', note: describeError(error) }
    }
    if (snapshot === undefined || snapshot === null) {
      return { id, missing: true, unsupported: false, title: '' }
    }

    const revision = String(snapshot.revision ?? '')
    const hit = cache.get(id)
    if (hit !== undefined && hit.revision === revision && Date.now() - hit.at < cacheMs) return hit.row

    const header = snapshot.header ?? {}
    let events = []
    let unsupported = false
    try {
      events = await readEvents(persistence, id, transcriptBlocks)
    } catch (error) {
      unsupported = true
      cache.set(id, {
        revision,
        at: Date.now(),
        row: baseRow(id, header, snapshot, undefined, true, describeError(error)),
      })
      return cache.get(id).row
    }

    const row = baseRow(id, header, snapshot, events, unsupported, undefined)
    cache.set(id, { revision, at: Date.now(), row })
    return row
  }

  /**
   * Assemble one list row from a header, its events and its artifact size.
   * @param id - the session id.
   * @param header - the persisted header.
   * @param snapshot - the persistence snapshot (`sizeBytes`, `revision`).
   * @param events - the stored events, when they could be read.
   * @param unsupported - whether the log refused interpretation.
   * @param note - a failure message worth showing.
   * @returns the row.
   */
  function baseRow(id, header, snapshot, events, unsupported, note) {
    const messages = events ?? []
    const title = displayTitle(messages)
    const times = messages.map((event) => (typeof event?.time === 'number' ? event.time : 0))
    const lastTime = times.length === 0 ? 0 : Math.max(...times)
    return {
      id,
      title,
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
      updatedAt: lastTime > 0 ? lastTime : typeof header.createdAt === 'number' ? header.createdAt : 0,
      sizeBytes: typeof snapshot?.sizeBytes === 'number' ? snapshot.sizeBytes : 0,
      messages: messages.filter((event) => isUserAuthored(event) || event?.type === 'assistant/message').length,
      missing: false,
      unsupported,
      note,
    }
  }

  /**
   * The archived set, newest archive first, joined with the workspace that
   * accounts for each id.
   *
   * The registry appends to `archivedSessionIds` on every archive and never
   * reorders it, so the array *is* archive order — oldest first. The page wants
   * the opposite, and reversing the array is exact: no timestamp is stored per
   * archive entry, and re-archiving a session moves it to the end, which is
   * precisely "archived most recently".
   *
   * The registry lists workspaces in display order and each entity's `sessionIds`
   * is already filtered by session existence, so a workspace name is only a
   * lookup — no second pass over the filesystem.
   * @returns the rows plus the workspace vocabulary the UI needs.
   */
  async function list() {
    const { registry, persistence } = services()
    if (persistence === undefined) {
      return { ok: false, error: { code: 'no-persistence', message: 'session persistence is not mounted' }, archived: [], workspaces: [] }
    }
    await sweepTombstones()
    const tombstones = await readTombstones(tombstonePath)
    const archivedIds = Array.isArray(registry?.archivedSessionIds)
      ? [...registry.archivedSessionIds].reverse().filter((rawId) => !tombstones.has(String(rawId)))
      : []
    const workspaces = (registry?.list?.() ?? []).map((entity) => ({
      workspaceId: String(entity.id),
      title: typeof entity.title === 'string' ? entity.title : '',
      path: typeof entity.path === 'string' ? entity.path : '',
      sessionIds: [...entity.sessionIds].map(String),
    }))
    const byWorkspace = new Map()
    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds) byWorkspace.set(sessionId, workspace)
    }

    const archived = []
    let bytes = 0
    for (const rawId of archivedIds) {
      const id = String(rawId)
      const row = await describe(id, persistence)
      const owner = byWorkspace.get(id)
      bytes += row.sizeBytes ?? 0
      archived.push({
        ...row,
        workspaceId: owner?.workspaceId ?? '',
        workspaceTitle: owner?.title ?? '',
      })
    }

    return { ok: true, archived, workspaces, counts: { archived: archived.length, bytes } }
  }

  /**
   * One conversation's blocks, for the preview modal.
   * @param id - the session to read.
   * @param limit - maximum events to render.
   * @returns the preview payload; `ok: false` carries the reason.
   */
  async function transcript(id, limit) {
    const { persistence } = services()
    if (persistence === undefined) return { ok: false, error: { code: 'no-persistence', message: 'session persistence is not mounted' } }
    const bound = positiveInt(limit, transcriptBlocks)
    let snapshot
    try {
      snapshot = await persistence.stat(id)
    } catch (error) {
      return { ok: false, error: { code: 'unreadable', message: describeError(error) } }
    }
    if (snapshot === undefined || snapshot === null) {
      return { ok: false, error: { code: 'missing', message: `session "${id}" has no stored log` } }
    }
    let events
    try {
      events = await readEvents(persistence, id, bound)
    } catch (error) {
      return { ok: false, error: { code: 'unreadable', message: describeError(error) } }
    }
    const header = snapshot.header ?? {}
    const blocks = transcriptOf(events)
    return {
      ok: true,
      id,
      title: displayTitle(events),
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
      sizeBytes: typeof snapshot.sizeBytes === 'number' ? snapshot.sizeBytes : 0,
      blocks,
      truncated: events.length >= bound,
      rendered: events.length,
    }
  }

  /**
   * Give the Host a moment to let go of one session.
   *
   * A live session whose next append would recreate the log we are about to
   * remove is worth waiting for — but only briefly. Being materialized in the
   * Host's store is **not** the same as being open in a view: the store keeps a
   * session object after the user navigates away, which is why refusing on it
   * locked users out of deleting conversations nobody was reading.
   * @param id - the session id.
   * @returns whether the session was released before the deadline.
   */
  async function waitReleased(id) {
    const deadline = Date.now() + releaseWaitMs
    for (;;) {
      const live = services().live
      let held = false
      try {
        held = live?.get?.(id) !== undefined
      } catch {
        held = false
      }
      if (!held) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /**
   * The running-work providers' answer for one session.
   * @param id - the session id.
   * @returns the reported activities; empty when nothing is running.
   */
  async function activityOf(id) {
    if (typeof ctx.waterfall !== 'function') return []
    try {
      const reported = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]))
      return Array.isArray(reported) ? reported : []
    } catch {
      return []
    }
  }

  /**
   * Every path one session owns on disk.
   *
   * The backend can name its own artifact (`locate`), which is authoritative; the
   * one-level scan is the fallback for a backend that cannot, and it also picks
   * up a session directory whose file name this build does not know.
   * @param persistence - the persistence service.
   * @param header - the persisted header, when it could be read.
   * @param id - the session id.
   * @returns directories and files to remove, parents before children.
   */
  async function artifactPaths(persistence, header, id) {
    const paths = new Set()
    if (header !== undefined && typeof persistence.locate === 'function') {
      try {
        const located = persistence.locate(header)
        if (typeof located?.path === 'string' && located.path.length > 0) {
          paths.add(located.path)
          paths.add(dirname(located.path))
        }
      } catch {
        /* a backend without a filesystem artifact simply has none to remove */
      }
    }
    const root = typeof persistence.root === 'string' ? persistence.root : join(dshHome(), 'sessions')
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const candidate = join(root, entry.name, id)
        if (basename(candidate) !== id) continue
        try {
          if ((await stat(candidate)).isDirectory()) paths.add(candidate)
        } catch {
          /* the id is not in this project bucket */
        }
      }
    } catch {
      /* no root, no scan: `locate` already covered the normal path */
    }
    return [...paths]
  }

  /**
   * The subset of `paths` that actually exists.
   *
   * A session can be listed by the Host while nothing is stored for it: the JSONL
   * backend's `list()` also yields `tracker.pendingEntries()` — sessions created
   * in this process that never reached disk — and `stat()` happily reports their
   * header. `locate()` still names the path such a session *would* have, so a
   * delete must check the filesystem instead of trusting the path list, or it
   * reports a removal that never happened.
   * @param paths - candidate paths.
   * @returns the paths that exist right now.
   */
  async function existingPaths(paths) {
    const found = []
    for (const path of paths) {
      try {
        await stat(path)
        found.push(path)
      } catch {
        /* not on disk: nothing to remove here */
      }
    }
    return found
  }

  /**
   * Remove every artifact path, retrying the failures Windows produces when a
   * handle is still open. A short append window is transient; a session that
   * keeps writing is not, and the caller must hear about that.
   *
   * `rm` is not trusted on its own: `force` swallows a missing file but says
   * nothing about a directory it could not empty, so every attempt is verified
   * against the filesystem rather than the backend's view of it.
   * @param paths - paths known to exist.
   * @returns undefined on success, otherwise the last failure message.
   */
  async function removeArtifacts(paths) {
    if (paths.length === 0) return undefined
    let lastError
    for (let attempt = 0; attempt < 4; attempt += 1) {
      lastError = undefined
      for (const path of paths) {
        try {
          await rm(path, { recursive: true, force: true })
        } catch (error) {
          lastError = error
        }
      }
      if (lastError === undefined && (await existingPaths(paths)).length === 0) return undefined
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
    return lastError !== undefined
      ? describeError(lastError)
      : `the stored log is still on disk (${paths.join(', ')})`
  }

  /**
   * Take a live session out of the Host's store.
   *
   * `session.list` unions stored records with `ctx.sessions.list()`, and a live
   * session is kept for the whole process, so removing the log alone leaves the
   * row on screen. The store exposes the exact pair its own detach closure uses:
   * `liveEntryFor(session)` names the entry and `detachEntered(entry)` removes it
   * (with its bookkeeping, and the `session/disposed` edge when it was announced).
   * That is the only way a plugin can make the id stop being live.
   * @param store - the `sessions` service.
   * @param id - the session id.
   * @returns whether the session left the store.
   */
  function evictLive(store, id) {
    try {
      const session = store?.get?.(id)
      if (session === undefined) return false
      if (typeof store.liveEntryFor !== 'function' || typeof store.detachEntered !== 'function') return false
      const entry = store.liveEntryFor(session)
      store.detachEntered(entry)
      return store.get(id) === undefined
    } catch {
      return false
    }
  }

  /**
   * What still reports this id after its log was removed.
   *
   * Two independent sources can put a row back on screen with nothing behind it,
   * and they need different treatment:
   *
   *   - `resident` — `ctx.sessions` still holds the session object. `session.list`
   *     unions those in, and the store keeps them for the whole process. This one
   *     can be evicted, which removes the row outright.
   *   - `stored` — the backend itself still reports the id. The JSONL backend's
   *     `list()` includes `tracker.pendingEntries()`: sessions created in this
   *     process that never reached disk, whose `stat()` still returns a header and
   *     whose `locate()` names a path that does not exist. Nothing can be removed
   *     for them, so they can only be hidden.
   * @param persistence - the persistence service.
   * @param live - the `sessions` service.
   * @param id - the session id.
   * @returns which sources still know the id.
   */
  async function lingering(persistence, live, id) {
    let resident = false
    try {
      resident = live?.get?.(id) !== undefined
    } catch {
      resident = true
    }
    let stored = false
    let unreadable = false
    try {
      stored = (await persistence.stat(id)) !== undefined
    } catch {
      unreadable = true
    }
    return { resident, stored: stored || unreadable }
  }

  /**
   * Delete one session: artifact first, registry accounting last.
   * @param id - the session id.
   * @returns the per-session outcome.
   */
  async function removeOne(id) {
    const { registry, persistence, live } = services()
    if (persistence === undefined) return { id, ok: false, code: 'no-persistence', message: 'session persistence is not mounted' }

    const activity = await activityOf(id)
    if (activity.length > 0) {
      return { id, ok: false, code: 'running', message: 'this conversation is still running; stop it before deleting' }
    }
    // Best effort, never a refusal: see `waitReleased`. Its result only feeds the
    // outcome, because a session the store keeps is no reason to refuse a delete.
    const released = await waitReleased(id)

    let header
    try {
      header = (await persistence.stat(id))?.header
    } catch {
      header = undefined
    }

    // The artifact goes first, and only when it is really gone does the
    // accounting move. The old order was the other way round, which is what made
    // a failed removal leave an ungrouped row with nothing behind it. `present`
    // is what the filesystem actually holds — a never-materialized session names
    // a path that was never created, and reporting that as removed is the lie the
    // user saw as "删除成功，什么都没变".
    const present = await existingPaths(await artifactPaths(persistence, header, id))
    const failure = await removeArtifacts(present)
    if (failure !== undefined) {
      return { id, ok: false, code: 'locked', message: failure }
    }

    // Drop whatever the user had set up (an archive entry, a pin) before deciding
    // how the row leaves the sidebar.
    if (typeof registry?.unarchiveSession === 'function') await registry.unarchiveSession(id)
    if (typeof registry?.unpinSession === 'function') await registry.unpinSession(id)

    const { resident, stored } = await lingering(persistence, live, id)
    let evicted = false
    let hidden = false
    if (resident || stored) {
      if (stored) {
        // The backend still counts it, so hiding is the only lever — and it has to
        // happen while the session is still known to the registry, which is why
        // the archive comes before the eviction.
        hidden = await hideLive(id, registry)
      } else {
        // Only the resident object is left: taking it out of the store is the
        // honest version of a delete, and it needs no archive bookkeeping.
        evicted = evictLive(live, id)
        if (!evicted) hidden = await hideLive(id, registry)
      }
      if (!evicted && !hidden) {
        return {
          id,
          ok: false,
          code: 'ghost',
          message: 'the stored log was deleted, but this conversation is still held in memory and cannot be hidden; restart DeepSeek Harness to clear the row',
          removed: present.length,
        }
      }
      // A session evicted after being hidden would take the archive entry with it
      // on the next sweep, which is exactly right; one that is still resident can
      // write its log back, so make sure it cannot.
      if (hidden && resident) evicted = evictLive(live, id)
    }

    // Accounting last: the id must never be unaccounted while it is still
    // listable, or the sidebar renders it under 未分组.
    for (const entity of registry?.list?.() ?? []) {
      if (!entity.sessionIds.includes(id)) continue
      await entity.detachSession(id)
    }
    cache.delete(id)

    const result = { id, ok: true, removed: present.length }
    if (!released) result.live = true
    if (evicted) result.released = true
    if (hidden) result.hidden = true
    return result
  }

  /**
   * Hide a session whose log is gone but whose object is still live.
   *
   * The archive set is the only lever a plugin has: archiving hides an id from
   * every grouping surface without tearing anything down, and it is what stops
   * `session.list` from surfacing a row with no artifact behind it. The id is
   * remembered so `sweepTombstones` can drop the entry once the session is no
   * longer live.
   * @param id - the session id.
   * @param registry - the workspace registry.
   * @returns whether the id is now hidden.
   */
  async function hideLive(id, registry) {
    if (typeof registry?.archiveSession !== 'function') return false
    try {
      await registry.archiveSession(id)
    } catch {
      return false
    }
    const ids = await readTombstones(tombstonePath)
    ids.add(id)
    await writeTombstones(tombstonePath, ids)
    return true
  }

  /**
   * Drop archive entries this plugin created only to hide a deleted log.
   *
   * A tombstoned id stays archived for exactly as long as its session is live:
   * that is what hides the ghost. Once the session is gone (typically after a
   * Host restart) the entry has no purpose and no log, so the archive set is
   * returned to the state the user left it in.
   * @returns how many ids were released.
   */
  async function sweepTombstones() {
    const ids = await readTombstones(tombstonePath)
    if (ids.size === 0) return 0
    const { registry, persistence, live } = services()
    // Without every service the sweep cannot tell "gone" from "not looked at
    // yet", and releasing an entry it cannot re-archive would strand it, so an
    // incomplete mount simply leaves the tombstones for a later pass.
    if (persistence === undefined || live === undefined || typeof registry?.unarchiveSession !== 'function') return 0
    let swept = 0
    for (const id of [...ids]) {
      let held = false
      try {
        held = live?.get?.(id) !== undefined
      } catch {
        held = true
      }
      if (held) continue
      let stored = true
      try {
        stored = (await persistence.stat(id)) !== undefined
      } catch {
        stored = true
      }
      if (stored) continue
      if (typeof registry?.unarchiveSession === 'function') {
        try {
          await registry.unarchiveSession(id)
        } catch {
          continue
        }
      }
      ids.delete(id)
      swept += 1
    }
    if (swept > 0) await writeTombstones(tombstonePath, ids)
    return swept
  }

  /**
   * Delete several sessions, one failure never aborting the rest.
   * @param ids - the normalized ids.
   * @returns one outcome per id.
   */
  async function remove(ids) {
    await sweepTombstones()
    const results = []
    for (const id of ids) {
      try {
        results.push(await removeOne(id))
      } catch (error) {
        results.push({ id, ok: false, code: 'error', message: describeError(error) })
      }
    }
    return results
  }

  /**
   * Drop ids from the archive set without touching their logs.
   * @param ids - the normalized ids.
   * @returns one outcome per id.
   */
  async function restore(ids) {
    const { registry } = services()
    if (typeof registry?.unarchiveSession !== 'function') {
      return ids.map((id) => ({ id, ok: false, code: 'no-registry', message: 'workspace registry is not mounted' }))
    }
    const tombstones = await readTombstones(tombstonePath)
    let released = 0
    const results = []
    for (const id of ids) {
      try {
        await registry.unarchiveSession(id)
        cache.delete(id)
        if (tombstones.delete(id)) released += 1
        results.push({ id, ok: true })
      } catch (error) {
        results.push({ id, ok: false, code: 'error', message: describeError(error) })
      }
    }
    if (released > 0) await writeTombstones(tombstonePath, tombstones)
    return results
  }

  return { list, transcript, remove, restore, sweep: sweepTombstones }
}

/**
 * Read one config number, falling back when the value is not a usable integer.
 * @param value - the raw config value.
 * @param fallback - the default.
 * @returns a positive integer.
 */
function positiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
