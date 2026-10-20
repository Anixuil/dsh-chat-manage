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
 * session headers through the official services, and it deletes by removing the
 * artifact plus every registry reference to it, in that order of authority:
 *
 *   1. refuse while a client still holds the session (a live agent would write
 *      the log back after we removed it),
 *   2. refuse while the session reports running work,
 *   3. drop the registry accounting (workspace slot, archive set, pin set),
 *   4. remove the artifact directory the backend points at.
 *
 * Everything is addressed by the session id; nothing here guesses at paths when
 * the backend can name them itself.
 *
 * Only `node:` builtins are imported, so this file loads with or without the
 * Harness packages present and can be unit-tested from plain Node.
 */

import { readdir, rm, stat } from 'node:fs/promises'
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
    const archivedIds = Array.isArray(registry?.archivedSessionIds) ? [...registry.archivedSessionIds].reverse() : []
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
   * Delete one session: registry references first, artifact second.
   * @param id - the session id.
   * @returns the per-session outcome.
   */
  async function removeOne(id) {
    const { registry, persistence } = services()
    if (persistence === undefined) return { id, ok: false, code: 'no-persistence', message: 'session persistence is not mounted' }

    const activity = await activityOf(id)
    if (activity.length > 0) {
      return { id, ok: false, code: 'running', message: 'this conversation is still running; stop it before deleting' }
    }
    // Best effort, never a refusal: see `waitReleased`. `live` in the result only
    // tells the caller the session object outlived the grace window.
    const released = await waitReleased(id)

    let header
    try {
      header = (await persistence.stat(id))?.header
    } catch {
      header = undefined
    }

    // Registry accounting goes first: if the artifact removal fails afterwards the
    // conversation is merely un-archived and still deletable, which is a state the
    // user can see and retry. The reverse order would leave a dangling id in the
    // archive set that no surface can ever clear.
    for (const entity of registry?.list?.() ?? []) {
      if (!entity.sessionIds.includes(id)) continue
      await entity.detachSession(id)
    }
    if (typeof registry?.unarchiveSession === 'function') await registry.unarchiveSession(id)
    if (typeof registry?.unpinSession === 'function') await registry.unpinSession(id)

    const paths = await artifactPaths(persistence, header, id)
    for (const path of paths) {
      await rm(path, { recursive: true, force: true })
    }
    cache.delete(id)

    return released ? { id, ok: true, removed: paths.length } : { id, ok: true, removed: paths.length, live: true }
  }

  /**
   * Delete several sessions, one failure never aborting the rest.
   * @param ids - the normalized ids.
   * @returns one outcome per id.
   */
  async function remove(ids) {
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
    const results = []
    for (const id of ids) {
      try {
        await registry.unarchiveSession(id)
        cache.delete(id)
        results.push({ id, ok: true })
      } catch (error) {
        results.push({ id, ok: false, code: 'error', message: describeError(error) })
      }
    }
    return results
  }

  return { list, transcript, remove, restore }
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
