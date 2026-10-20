/**
 * Offline smoke suite for dsh-chat-manage.
 *
 * The Host half only imports `node:` builtins, so the whole maintenance layer can
 * be exercised without a Harness runtime: a fake context supplies the three
 * services, a real temporary directory supplies the artifacts, and every
 * assertion is about behaviour a user can observe — what is listed, what is
 * refused, what is gone from disk afterwards.
 *
 * Run with `node dev/smoke.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createSessionManager,
  describeContent,
  displayTitle,
  normalizeIds,
  titleOf,
  toolHint,
  transcriptOf,
} from '../sessions.js'

/** One-line test runner: name, then the body. */
const cases = []
function test(name, body) {
  cases.push({ name, body })
}

/** Build a stored event with the fields the fold actually reads. */
function event(type, data, seq, time = 1_000 + seq) {
  return { type, seq, time, data }
}

/** A tiny in-memory stand-in for the JSONL backend, backed by a real directory. */
function fakePersistence(root, store) {
  return {
    root,
    async stat(id) {
      const entry = store.get(id)
      if (entry === undefined) return undefined
      return { header: entry.header, revision: entry.revision ?? 'r1', sizeBytes: entry.sizeBytes ?? 10 }
    },
    async open(id) {
      const entry = store.get(id)
      if (entry === undefined) {
        const error = new Error(`session "${id}" not found`)
        error.name = 'SessionPersistenceNotFoundError'
        throw error
      }
      if (entry.unreadable === true) throw new Error('stored session failed validation')
      return {
        async read(offset, length) {
          return { eventState: 'current', events: entry.events.slice(offset, offset + length) }
        },
        close() {},
      }
    },
    locate(meta) {
      return { kind: 'jsonl', path: join(root, 'project', meta.id, 'session.v4.jsonl.zstd') }
    },
  }
}

/** A registry stand-in holding one workspace and a mutable archive set. */
function fakeRegistry(archivedSessionIds, workspaces) {
  const detached = []
  const entities = workspaces.map((workspace) => ({
    id: workspace.workspaceId,
    title: workspace.title,
    path: workspace.path,
    sessionIds: [...workspace.sessionIds],
    async detachSession(id) {
      detached.push({ workspaceId: workspace.workspaceId, id })
      workspace.sessionIds = workspace.sessionIds.filter((value) => value !== id)
      this.sessionIds = [...workspace.sessionIds]
    },
  }))
  return {
    archivedSessionIds,
    detached,
    list: () => entities,
    async unarchiveSession(id) {
      const index = this.archivedSessionIds.indexOf(id)
      if (index >= 0) this.archivedSessionIds.splice(index, 1)
    },
    async unpinSession() {},
  }
}

/** A context whose services are exactly what `createSessionManager` reads. */
function fakeContext(services) {
  const byKey = {
    sessionPersistence: services.persistence,
    workspaceRegistry: services.registry,
    sessions: services.live,
  }
  return {
    get: (key) => byKey[key],
    waterfall: async () => services.activity ?? [],
  }
}

/** Create a real artifact directory so removal has something to delete. */
async function materialize(root, id) {
  const dir = join(root, 'project', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'artifact', 'utf8')
  return dir
}

/** Whether a path exists. */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

//#region pure helpers

test('normalizeIds deduplicates, trims and bounds the batch', () => {
  assert.deepEqual(normalizeIds([' a ', 'a', 'b', '', 7, null]), ['a', 'b'])
  assert.deepEqual(normalizeIds('nope'), [])
  assert.equal(normalizeIds(Array.from({ length: 500 }, (_value, index) => `id-${index}`)).length, 200)
})

test('describeContent keeps text, counts images, drops reasoning', () => {
  const result = describeContent([
    { type: 'reasoning', text: 'private' },
    { type: 'text', text: 'hello' },
    { type: 'image', attachment: { name: 'a.png' } },
    { type: 'tool-call', name: 'pwsh' },
    { type: 'text', text: '   ' },
  ])
  assert.deepEqual(result, { text: 'hello', images: 1 })
  assert.deepEqual(describeContent(undefined), { text: '', images: 0 })
})

test('toolHint prefers the human description and survives bad JSON', () => {
  assert.equal(toolHint('{"description":"Sum the amounts","command":"x"}'), 'Sum the amounts')
  assert.equal(toolHint('{"command":"ls"}'), 'ls')
  assert.equal(toolHint('not json'), 'not json')
  assert.equal(toolHint(''), '')
})

test('titleOf takes the newest title event', () => {
  const events = [
    event('session/title', { title: 'first' }, 1),
    event('user/message', { content: [{ type: 'text', text: 'hi' }] }, 2),
    event('session/title', { title: 'second' }, 3),
  ]
  assert.equal(titleOf(events), 'second')
  assert.equal(titleOf([]), undefined)
})

test('displayTitle falls back to the opening line when the window cuts the title', () => {
  assert.equal(displayTitle([event('session/title', { title: 'named' }, 1)]), 'named')
  assert.equal(
    displayTitle([event('user/message', { content: [{ type: 'text', text: '  帮我看看这个  ' }], source: { kind: 'user' } }, 1)]),
    '帮我看看这个',
  )
  assert.equal(
    displayTitle([event('user/message', { content: [{ type: 'text', text: 'Current runtime context…' }], source: { kind: 'runtime-context' } }, 1)]),
    '',
    'a window holding only injected context names nothing',
  )
  assert.equal(displayTitle([]), '')
})

test('transcriptOf folds the log into user / assistant / tool blocks', () => {
  const blocks = transcriptOf([
    event('turn/start', { turn: 1 }, 0),
    event('user/message', { content: [{ type: 'text', text: '你好' }, { type: 'image' }] }, 1),
    event('assistant/message', { message: { content: [{ type: 'reasoning', text: 'think' }] } }, 2),
    event('tool/call', { name: 'pwsh', arguments: '{"description":"list files"}' }, 3),
    event('assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } }, 4),
  ])
  assert.deepEqual(blocks.map((block) => block.kind), ['user', 'tool', 'assistant'])
  assert.equal(blocks[0].images, 1)
  assert.equal(blocks[1].name, 'pwsh')
  assert.equal(blocks[1].text, 'list files')
  assert.equal(blocks[2].text, 'done')
})

test('transcriptOf drops the context the Host injects into the log', () => {
  const blocks = transcriptOf([
    event('user/message', { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }, 1),
    event('user/message', { content: [{ type: 'text', text: 'Current runtime context…' }], source: { kind: 'runtime-context' } }, 2),
    event('user/message', { content: [{ type: 'text', text: '<system-reminder>…' }], source: { kind: 'skill-catalog' } }, 3),
    event('user/message', { content: [{ type: 'text', text: 'subagent failed' }], source: { kind: 'subagent-settled' } }, 4),
    event('assistant/message', { message: { content: [{ type: 'text', text: '好的' }] } }, 5),
  ])
  assert.deepEqual(blocks.map((block) => block.text), ['你好', '好的'])
})

//#endregion

//#region maintenance behaviour

test('list joins the archive set with its workspace and metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcm-list-'))
  try {
    const store = new Map()
    store.set('session-a', {
      header: { id: 'session-a', cwd: 'C:/work/demo', createdAt: 100 },
      events: [
        event('user/message', { content: [{ type: 'text', text: '归档一下' }] }, 1),
        event('session/title', { title: '归档的对话' }, 2),
        event('assistant/message', { message: { content: [{ type: 'text', text: '好' }] } }, 3),
      ],
      sizeBytes: 2048,
    })
    const registry = fakeRegistry(['session-a', 'session-ghost'], [
      { workspaceId: 'ws-1', title: 'demo', path: 'C:/work/demo', sessionIds: ['session-a'] },
    ])
    const manager = createSessionManager(
      fakeContext({ persistence: fakePersistence(root, store), registry, live: { get: () => undefined } }),
      { releaseWaitMs: 50 },
    )

    const result = await manager.list()
    assert.equal(result.ok, true)
    assert.equal(result.archived.length, 2)
    assert.equal(result.archived[0].title, '归档的对话')
    assert.equal(result.archived[0].workspaceTitle, 'demo')
    assert.equal(result.archived[0].messages, 2)
    assert.equal(result.archived[0].sizeBytes, 2048)
    assert.equal(result.archived[1].missing, true, 'a dangling archive id is still listed')
    assert.equal(result.counts.bytes, 2048)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('list survives a log this build cannot interpret', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcm-broken-'))
  try {
    const store = new Map([['session-x', { header: { id: 'session-x', createdAt: 1 }, events: [], unreadable: true }]])
    const manager = createSessionManager(
      fakeContext({ persistence: fakePersistence(root, store), registry: fakeRegistry(['session-x'], []), live: { get: () => undefined } }),
      { releaseWaitMs: 50 },
    )
    const result = await manager.list()
    assert.equal(result.archived[0].unsupported, true)
    assert.equal(result.archived[0].missing, false)
    assert.match(result.archived[0].note, /failed validation/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('transcript renders blocks and reports truncation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcm-preview-'))
  try {
    const events = Array.from({ length: 8 }, (_value, index) =>
      event('user/message', { content: [{ type: 'text', text: `turn ${index}` }] }, index),
    )
    const store = new Map([['session-t', { header: { id: 'session-t', cwd: 'C:/w', createdAt: 5 }, events }]])
    const manager = createSessionManager(
      fakeContext({ persistence: fakePersistence(root, store), registry: fakeRegistry([], []), live: { get: () => undefined } }),
      { releaseWaitMs: 50 },
    )
    const full = await manager.transcript('session-t')
    assert.equal(full.ok, true)
    assert.equal(full.blocks.length, 8)
    assert.equal(full.truncated, false)

    const short = await manager.transcript('session-t', 3)
    assert.equal(short.blocks.length, 3)
    assert.equal(short.truncated, true)

    const missing = await manager.transcript('session-nope')
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'missing')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('delete removes the artifact and every registry reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcm-delete-'))
  try {
    const id = 'session-del'
    const dir = await materialize(root, id)
    const store = new Map([['session-del', { header: { id, cwd: 'C:/w', createdAt: 1 }, events: [] }]])
    const registry = fakeRegistry([id], [{ workspaceId: 'ws-1', title: 'demo', path: 'C:/w', sessionIds: [id] }])
    const manager = createSessionManager(
      fakeContext({ persistence: fakePersistence(root, store), registry, live: { get: () => undefined } }),
      { releaseWaitMs: 50 },
    )

    const results = await manager.remove([id])
    assert.equal(results[0].ok, true)
    assert.equal(await exists(dir), false, 'the artifact directory is gone')
    assert.deepEqual(registry.archivedSessionIds, [], 'the archive set no longer holds the id')
    assert.deepEqual(registry.detached, [{ workspaceId: 'ws-1', id }])
    assert.deepEqual(store.has(id), true, 'the fake store is not the point: the file is')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('delete refuses a conversation a client still holds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcm-live-'))
  try {
    const id = 'session-live'
    const dir = await materialize(root, id)
    const store = new Map([['session-live', { header: { id, cwd: 'C:/w', createdAt: 1 }, events: [] }]])
    const registry = fakeRegistry([id], [])
    const manager = createSessionManager(
      fakeContext({ persistence: fakePersistence(root, store), registry, live: { get: () => ({ id }) } }),
      { releaseWaitMs: 120 },
    )

    const results = await manager.remove([id])
    assert.equal(results[0].ok, false)
    assert.equal(results[0].code, 'in-use')
    assert.equal(await exists(dir), true, 'nothing was removed')
    assert.deepEqual(registry.archivedSessionIds, [id])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('delete refuses a conversation that reports running work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcm-running-'))
  try {
    const id = 'session-run'
    const dir = await materialize(root, id)
    const store = new Map([['session-run', { header: { id, cwd: 'C:/w', createdAt: 1 }, events: [] }]])
    const manager = createSessionManager(
      fakeContext({
        persistence: fakePersistence(root, store),
        registry: fakeRegistry([id], []),
        live: { get: () => undefined },
        activity: [{ kind: 'turn' }],
      }),
      { releaseWaitMs: 50 },
    )

    const results = await manager.remove([id])
    assert.equal(results[0].code, 'running')
    assert.equal(await exists(dir), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('delete clears a dangling archive entry whose log is already gone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcm-ghost-'))
  try {
    const registry = fakeRegistry(['session-ghost'], [])
    const manager = createSessionManager(
      fakeContext({ persistence: fakePersistence(root, new Map()), registry, live: { get: () => undefined } }),
      { releaseWaitMs: 50 },
    )
    const results = await manager.remove(['session-ghost'])
    assert.equal(results[0].ok, true)
    assert.deepEqual(registry.archivedSessionIds, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restore drops ids from the archive set without touching logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcm-restore-'))
  try {
    const id = 'session-keep'
    const dir = await materialize(root, id)
    const registry = fakeRegistry([id], [])
    const manager = createSessionManager(
      fakeContext({ persistence: fakePersistence(root, new Map()), registry, live: { get: () => undefined } }),
      { releaseWaitMs: 50 },
    )
    const results = await manager.restore([id])
    assert.equal(results[0].ok, true)
    assert.deepEqual(registry.archivedSessionIds, [])
    assert.equal(await exists(dir), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing service is reported instead of thrown', async () => {
  const manager = createSessionManager(fakeContext({}), {})
  const listed = await manager.list()
  assert.equal(listed.ok, false)
  assert.equal(listed.error.code, 'no-persistence')
  const removed = await manager.remove(['x'])
  assert.equal(removed[0].code, 'no-persistence')
})

//#endregion

let failed = 0
for (const { name, body } of cases) {
  try {
    await body()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} checks failed`)
  process.exitCode = 1
} else {
  console.log(`\n${cases.length} checks passed`)
}
