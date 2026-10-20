/**
 * dsh-chat-manage — Host half.
 *
 * The browser half cannot do this work: the session artifacts live on the Host's
 * filesystem behind the persistence backend, and the archive set lives in the
 * workspace registry. So this half registers four plain HTTP routes under one
 * prefix and lets the client call them with `fetch`:
 *
 *   GET  /dsh-chat-manage/api/list                the archived set, with metadata
 *   GET  /dsh-chat-manage/api/transcript?id=…     one conversation, as blocks
 *   POST /dsh-chat-manage/api/delete   { ids }    delete conversations
 *   POST /dsh-chat-manage/api/restore  { ids }    un-archive conversations
 *
 * Plain routes rather than a Remote namespace on purpose: a route needs no
 * generated Typert artifact, so this plugin composes into any build without a
 * codegen step, and the contract stays readable in `sessions.js`.
 *
 * The plugin is inert without a web server: it waits for `webServer`, registers
 * its prefix, and disappears with the fiber.
 */

import { createSessionManager, describeError, normalizeIds } from './sessions.js'

/** Loader diagnostic name, matched by the row id in `cordis.patch.yml`. */
export const name = 'chat-manage'

/** Route prefix. Also the base every client request appends to. */
export const PREFIX = '/dsh-chat-manage'

/** One request body ceiling; every body this API takes is a list of ids. */
const MAX_BODY_BYTES = 256 * 1024

/**
 * Mount the API.
 * @param ctx - the plugin context.
 * @param config - the Loader row's config; every key is optional.
 */
export function apply(ctx, config) {
  const options = {
    transcriptBlocks: config?.transcriptBlocks,
    listCacheSeconds: config?.listCacheSeconds,
    releaseWaitMs: config?.releaseWaitMs,
  }

  ctx.inject(['webServer'], (webCtx) => {
    const manager = createSessionManager(webCtx, options)
    const dispose = webCtx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (req, res) => {
        void route(manager, req, res)
      },
    })
    webCtx.effect(() => dispose, 'dsh-chat-manage: routes')
  })
}

/**
 * Dispatch one request to the manager.
 * @param manager - the maintenance facade.
 * @param req - the Node request.
 * @param res - the Node response.
 */
async function route(manager, req, res) {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.slice(PREFIX.length)

    if (req.method === 'GET' && path === '/api/list') {
      send(res, 200, await manager.list())
      return
    }
    if (req.method === 'GET' && path === '/api/transcript') {
      const id = url.searchParams.get('id') ?? ''
      if (id.trim().length === 0) {
        send(res, 400, { ok: false, error: { code: 'bad-request', message: 'id is required' } })
        return
      }
      const limit = Number(url.searchParams.get('limit') ?? '')
      send(res, 200, await manager.transcript(id.trim(), Number.isFinite(limit) ? limit : undefined))
      return
    }
    if (req.method === 'POST' && (path === '/api/delete' || path === '/api/restore')) {
      const body = await readJson(req)
      const ids = normalizeIds(body?.ids)
      if (ids.length === 0) {
        send(res, 400, { ok: false, error: { code: 'bad-request', message: 'ids must be a non-empty array of session ids' } })
        return
      }
      const results = path === '/api/delete' ? await manager.remove(ids) : await manager.restore(ids)
      send(res, 200, { ok: results.every((result) => result.ok === true), results })
      return
    }

    send(res, 404, { ok: false, error: { code: 'not-found', message: `${req.method ?? 'GET'} ${url.pathname} is not part of this plugin's API` } })
  } catch (error) {
    // A failed route must never leave the socket hanging: the client turns any
    // non-JSON reply into a generic failure, and a hung request into a spinner.
    if (!res.headersSent) send(res, 500, { ok: false, error: { code: 'internal', message: describeError(error) } })
    else {
      try {
        res.end()
      } catch {
        /* the peer is already gone */
      }
    }
  }
}

/**
 * Read a JSON body with a hard size ceiling.
 * @param req - the Node request.
 * @returns the parsed body, or undefined when it is not JSON.
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim().length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Write one JSON reply.
 * @param res - the Node response.
 * @param status - HTTP status.
 * @param payload - anything JSON-serializable.
 */
function send(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}
