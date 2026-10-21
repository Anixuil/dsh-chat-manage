/**
 * Route-level integration suite for dsh-chat-manage.
 *
 * `dev/smoke.mjs` proves the maintenance layer; this file proves the wiring
 * around it. It boots a real `http.Server`, hands `apply()` a context whose only
 * job is to mount the prefix handler the way `dsh-host-webserver` does, and then
 * talks to it over real sockets with `fetch`. What is asserted is exactly what
 * the browser half sees: status codes, JSON shape, headers, and whether the
 * routes disappear once the fiber is disposed.
 *
 * Nothing here touches `~/.dsh`: the artifacts live in a temporary directory.
 *
 * Run with `node dev/http.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, PREFIX } from '../index.js'

const cases = []
function test(name, body) {
  cases.push({ name, body })
}

/** Build a stored event with the fields the fold reads. */
function event(type, data, seq) {
  return { type, seq, time: 1_000 + seq, data }
}

/** Minimal persistence stand-in, backed by a real directory. */
function fakePersistence(root, store) {
  return {
    root,
    async stat(id) {
      const entry = store.get(id)
      if (entry === undefined) return undefined
      return { header: entry.header, revision: 'r1', sizeBytes: 128 }
    },
    async open(id) {
      const entry = store.get(id)
      if (entry === undefined) throw new Error(`session "${id}" not found`)
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

/** Registry stand-in with a mutable archive set. */
function fakeRegistry(archivedSessionIds, workspaces) {
  const entities = workspaces.map((workspace) => ({
    id: workspace.workspaceId,
    title: workspace.title,
    path: workspace.path,
    sessionIds: [...workspace.sessionIds],
    async detachSession(id) {
      this.sessionIds = this.sessionIds.filter((value) => value !== id)
    },
  }))
  return {
    archivedSessionIds,
    list: () => entities,
    async unarchiveSession(id) {
      const index = this.archivedSessionIds.indexOf(id)
      if (index >= 0) this.archivedSessionIds.splice(index, 1)
    },
    async unpinSession() {},
  }
}

/** Create the artifact a delete is supposed to remove. */
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

/**
 * Boot a server and mount the plugin on it.
 * @param services - `{ persistence, registry, live, activity }`.
 * @param config - the Loader row config, passed straight to `apply`.
 * @returns `{ base, routes, close }`.
 */
async function boot(services, config) {
  const routes = []
  const effects = []

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const mounted = routes.find((entry) =>
      entry.kind === 'prefix' ? path.startsWith(entry.path) : path === entry.path,
    )
    if (mounted === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not mounted')
      return
    }
    mounted.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const ctx = {
    get: (key) =>
      ({ sessionPersistence: services.persistence, workspaceRegistry: services.registry, sessions: services.live })[key],
    waterfall: async () => services.activity ?? [],
    effect: (fn, label) => {
      effects.push({ fn, label })
    },
    webServer: {
      register(entry) {
        routes.push(entry)
        return () => {
          const index = routes.indexOf(entry)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    // `apply` asks for the service by name; the fake context already holds it.
    inject: (_deps, callback) => callback(ctx),
  }

  apply(ctx, config)

  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    routes,
    effects,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** One archived conversation with a title, a preview-able body and a workspace. */
async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const store = new Map([
    [
      'session-a',
      {
        header: { id: 'session-a', cwd: 'C:/work/demo', createdAt: 100 },
        events: [
          event('user/message', { content: [{ type: 'text', text: '把这段归档' }], source: { kind: 'user' } }, 1),
          event('user/message', { content: [{ type: 'text', text: 'Current runtime context…' }], source: { kind: 'runtime-context' } }, 2),
          event('session/title', { title: '归档的对话' }, 3),
          event('assistant/message', { message: { content: [{ type: 'text', text: '归档好了' }] } }, 4),
        ],
      },
    ],
  ])
  const registry = fakeRegistry(['session-a'], [
    { workspaceId: 'ws-1', title: 'demo', path: 'C:/work/demo', sessionIds: ['session-a'] },
  ])
  const dir = await materialize(root, 'session-a')
  return { root, store, registry, dir }
}

//#region routes

test('GET /api/list answers with the archived set', async () => {
  const fx = await fixture('dcm-http-list-')
  const server = await boot({ persistence: fakePersistence(fx.root, fx.store), registry: fx.registry, live: { get: () => undefined } })
  try {
    const response = await fetch(`${server.base}${PREFIX}/api/list`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-store')

    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.archived.length, 1)
    assert.equal(body.archived[0].id, 'session-a')
    assert.equal(body.archived[0].title, '归档的对话')
    assert.equal(body.archived[0].workspaceTitle, 'demo')
    assert.equal(body.counts.archived, 1)
  } finally {
    await server.close()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('GET /api/list hands the page the newest archive first', async () => {
  const fx = await fixture('dcm-http-order-')
  fx.store.set('session-b', {
    header: { id: 'session-b', cwd: 'C:/work/demo', createdAt: 200 },
    events: [event('session/title', { title: '后来的对话' }, 1)],
  })
  const server = await boot({
    persistence: fakePersistence(fx.root, fx.store),
    registry: fakeRegistry(['session-a', 'session-b'], []),
    live: { get: () => undefined },
  })
  try {
    const body = await (await fetch(`${server.base}${PREFIX}/api/list`)).json()
    assert.deepEqual(body.archived.map((row) => row.id), ['session-b', 'session-a'], 'archive order is reversed for display')
  } finally {
    await server.close()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('GET /api/transcript renders one conversation', async () => {
  const fx = await fixture('dcm-http-preview-')
  const server = await boot({ persistence: fakePersistence(fx.root, fx.store), registry: fx.registry, live: { get: () => undefined } })
  try {
    const body = await (await fetch(`${server.base}${PREFIX}/api/transcript?id=session-a`)).json()
    assert.equal(body.ok, true)
    assert.equal(body.title, '归档的对话')
    assert.deepEqual(body.blocks.map((block) => block.text), ['把这段归档', '归档好了'], 'the injected runtime context is filtered')
    assert.equal(body.truncated, false)
    assert.equal(body.cwd, 'C:/work/demo')
  } finally {
    await server.close()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('the transcript window follows the row config and the per-request limit', async () => {
  const fx = await fixture('dcm-http-limit-')
  const server = await boot(
    { persistence: fakePersistence(fx.root, fx.store), registry: fx.registry, live: { get: () => undefined } },
    { transcriptBlocks: 2 },
  )
  try {
    const capped = await (await fetch(`${server.base}${PREFIX}/api/transcript?id=session-a`)).json()
    assert.equal(capped.rendered, 2, 'the row config bounds the read')
    assert.equal(capped.truncated, true)
    assert.equal(capped.title, '把这段归档', 'a window cut before the title event falls back to the opening line')

    const explicit = await (await fetch(`${server.base}${PREFIX}/api/transcript?id=session-a&limit=1`)).json()
    assert.equal(explicit.rendered, 1)
    assert.equal(explicit.blocks.length, 1)
  } finally {
    await server.close()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('a transcript request without an id is rejected, not guessed', async () => {
  const fx = await fixture('dcm-http-noid-')
  const server = await boot({ persistence: fakePersistence(fx.root, fx.store), registry: fx.registry, live: { get: () => undefined } })
  try {
    const response = await fetch(`${server.base}${PREFIX}/api/transcript`)
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.code, 'bad-request')
  } finally {
    await server.close()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('POST /api/delete removes the conversation and reports per id', async () => {
  const fx = await fixture('dcm-http-delete-')
  const server = await boot({ persistence: fakePersistence(fx.root, fx.store), registry: fx.registry, live: { get: () => undefined } })
  try {
    const response = await fetch(`${server.base}${PREFIX}/api/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['session-a', 'session-ghost'] }),
    })
    assert.equal(response.status, 200)

    const body = await response.json()
    assert.equal(body.ok, true, 'a dangling id is cleared rather than failing the batch')
    assert.equal(body.results.length, 2)
    assert.equal(body.results[0].ok, true)
    assert.equal(await exists(fx.dir), false)
    assert.deepEqual(fx.registry.archivedSessionIds, [])
  } finally {
    await server.close()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('POST /api/delete goes ahead while the Host still holds the session', async () => {
  const fx = await fixture('dcm-http-live-')
  const server = await boot(
    { persistence: fakePersistence(fx.root, fx.store), registry: fx.registry, live: { get: (id) => ({ id }) } },
    { releaseWaitMs: 60 },
  )
  try {
    const response = await fetch(`${server.base}${PREFIX}/api/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['session-a'] }),
    })
    const body = await response.json()
    assert.equal(body.results[0].ok, true, 'a materialized session is not an open one')
    assert.equal(body.results[0].live, true, 'the caller can tell it outlived the grace window')
    assert.equal(await exists(fx.dir), false)
  } finally {
    await server.close()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('POST /api/delete refuses an empty id list', async () => {
  const fx = await fixture('dcm-http-empty-')
  const server = await boot({ persistence: fakePersistence(fx.root, fx.store), registry: fx.registry, live: { get: () => undefined } })
  try {
    const response = await fetch(`${server.base}${PREFIX}/api/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'bad-request')
    assert.equal(await exists(fx.dir), true)
  } finally {
    await server.close()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('a POST that is not declared as JSON is refused before it can act', async () => {
  const fx = await fixture('dcm-http-csrf-')
  const server = await boot({ persistence: fakePersistence(fx.root, fx.store), registry: fx.registry, live: { get: () => undefined } })
  try {
    // Browsers send this shape without a preflight, so accepting it would let any
    // page on the machine delete conversations by guessing the port.
    const response = await fetch(`${server.base}${PREFIX}/api/delete`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ ids: ['session-a'] }),
    })
    assert.equal(response.status, 415)
    assert.equal((await response.json()).error.code, 'unsupported-media-type')
    assert.equal(await exists(fx.dir), true, 'nothing was removed')
    assert.deepEqual(fx.registry.archivedSessionIds, ['session-a'])
  } finally {
    await server.close()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('POST /api/restore un-archives without deleting', async () => {
  const fx = await fixture('dcm-http-restore-')
  const server = await boot({ persistence: fakePersistence(fx.root, fx.store), registry: fx.registry, live: { get: () => undefined } })
  try {
    const response = await fetch(`${server.base}${PREFIX}/api/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['session-a'] }),
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ok, true)
    assert.deepEqual(fx.registry.archivedSessionIds, [])
    assert.equal(await exists(fx.dir), true, 'restore never touches the artifact')
  } finally {
    await server.close()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('an unknown path is answered in JSON so the client can read the reason', async () => {
  const fx = await fixture('dcm-http-404-')
  const server = await boot({ persistence: fakePersistence(fx.root, fx.store), registry: fx.registry, live: { get: () => undefined } })
  try {
    const response = await fetch(`${server.base}${PREFIX}/api/nope`)
    assert.equal(response.status, 404)
    const body = await response.json()
    assert.equal(body.error.code, 'not-found')
    assert.match(body.error.message, /\/api\/nope/u)
  } finally {
    await server.close()
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('disposing the fiber unmounts the prefix', async () => {
  const fx = await fixture('dcm-http-dispose-')
  const server = await boot({ persistence: fakePersistence(fx.root, fx.store), registry: fx.registry, live: { get: () => undefined } })
  try {
    assert.equal(server.routes.length, 1)
    assert.equal(server.routes[0].path, PREFIX)
    assert.equal(server.routes[0].kind, 'prefix')
    assert.equal(server.effects.length, 1, 'the registration is owned by an effect')

    // Cordis calls `effect(fn)` immediately and owns what `fn` returns.
    const dispose = server.effects[0].fn()
    dispose()
    assert.equal(server.routes.length, 0)
    const response = await fetch(`${server.base}${PREFIX}/api/list`)
    assert.equal(response.status, 404)
  } finally {
    await server.close()
    await rm(fx.root, { recursive: true, force: true })
  }
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
