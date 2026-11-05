// session-recap serve: a local viewer for every agent's sessions and their
// recaps (Recap and Map), at http://127.0.0.1:<port>/?t=<token>.
//
// It listens on loopback only, answers only requests that carry the token of
// this run (a cookie after the first page load) and a loopback Host header,
// so another site open in the browser cannot read sessions through it.

import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sectionsOf } from '../core/sections.mjs'
import { splitRecap, writeRecap } from '../core/recap.mjs'
import { isFreshFor, makeComplete, modelConfig, noteFiles, python, readCached, saveCached } from './session-recap.mjs'

/** @typedef {import('./session-recap.mjs').Session} Session */
/** @typedef {import('./session-recap.mjs').Options} Options */

const PAGE = join(dirname(fileURLToPath(import.meta.url)), 'viewer.html')
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * The stored recap of a session, split for the page.
 * @param {Session} session
 */
function recapOf(session) {
  const cached = readCached(session)
  if (cached === undefined) return null
  const { markdown, map } = splitRecap(cached.markdown)

  return {
    markdown,
    map: map ?? null,
    sections: sectionsOf(markdown),
    at: cached.at,
    model: cached.model ?? null,
    isFresh: isFreshFor(cached, session),
  }
}

/**
 * Finds a listed session by agent and id.
 * @param {string} agent
 * @param {string} id
 * @returns {Session | undefined}
 */
function sessionBy(agent, id) {
  /** @type {Session[]} */
  const rows = python(['find', id])
  return rows.find(r => r.agent === agent && r.id === id)
}

/** @type {Map<string, Promise<unknown>>} */
const running = new Map()

/**
 * Writes (or updates) a session's recap with the configured model.
 * @param {Session} session
 */
async function write(session) {
  const key = `${session.agent}:${session.id}`
  const busy = running.get(key)
  if (busy !== undefined) return busy
  const config = modelConfig()
  if (!config.apiKey || !config.baseUrl || !config.model) {
    throw Object.assign(
      new Error(
        'No model is configured for session-recap. Set one with `session-recap config set …`, or ask your agent to recap the session through the MCP server.',
      ),
      { status: 409 },
    )
  }
  const job = (async () => {
    const previous = readCached(session)
    const from = previous?.prompts !== undefined && !isFreshFor(previous, session) ? previous.prompts : 0
    const digest = python(['digest', session.agent, session.path, String(from)])
    const usage = { calls: 0, input: 0, output: 0 }
    const markdown = await writeRecap({
      digest,
      previous: from > 0 ? previous : undefined,
      complete: makeComplete(config, usage),
      notes: noteFiles,
    })
    saveCached(session, digest.prompts, markdown, config.model)
    return usage
  })()
  running.set(key, job)
  try {
    return await job
  } finally {
    running.delete(key)
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * The request handler, exported for tests.
 * @param {string} token
 */
export function handler(token) {
  const expected = Buffer.from(token)
  /** @param {string | undefined} given */
  const isToken = given => {
    const b = Buffer.from(given ?? '')
    return b.length === expected.length && timingSafeEqual(b, expected)
  }

  return async (
    /** @type {import('node:http').IncomingMessage} */ req,
    /** @type {import('node:http').ServerResponse} */ res,
  ) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const host = (req.headers.host ?? '').replace(/:\d+$/, '')
    if (!LOOPBACK.has(host)) return sendJson(res, 403, { error: 'not a local request' })
    const cookie = /(?:^|;\s*)sr_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
    const isPage = url.pathname === '/' && req.method === 'GET'
    if (!(isToken(cookie) || (isPage && isToken(url.searchParams.get('t') ?? undefined)))) {
      return sendJson(res, 401, { error: 'open the address session-recap serve printed' })
    }
    try {
      if (isPage) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': `sr_token=${token}; HttpOnly; SameSite=Strict; Path=/`,
          'content-security-policy':
            "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:",
          'cache-control': 'no-store',
        })
        return res.end(readFileSync(PAGE, 'utf8'))
      }
      if (url.pathname === '/api/projects' && req.method === 'GET') return sendJson(res, 200, python(['projects']))
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        /** @type {Session[]} */
        const rows = python(['sessions', url.searchParams.get('cwd') ?? ''])
        return sendJson(
          res,
          200,
          rows.map(r => {
            const recap = recapOf(r)
            return {
              ...r,
              recap: recap === null ? null : recap.isFresh ? 'fresh' : 'stale',
              intent: recap?.sections.intent ?? null,
            }
          }),
        )
      }
      if (url.pathname === '/api/recap') {
        // A form post from another site carries no custom header: require one.
        if (req.method === 'POST' && req.headers['x-session-recap'] !== '1')
          return sendJson(res, 403, { error: 'missing header' })
        const session = sessionBy(url.searchParams.get('agent') ?? '', url.searchParams.get('id') ?? '')
        if (session === undefined) return sendJson(res, 404, { error: 'no such session' })
        if (req.method === 'POST') {
          const usage = await write(session)
          return sendJson(res, 200, { session, recap: recapOf(session), usage })
        }
        return sendJson(res, 200, { session, recap: recapOf(session), canWrite: Boolean(modelConfig().apiKey) })
      }
      return sendJson(res, 404, { error: 'not found' })
    } catch (err) {
      const status = /** @type {{ status?: number }} */ (err).status ?? 500
      return sendJson(res, status, { error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/** @param {string} url */
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // No browser to open: the printed address is enough.
  }
}

/**
 * Starts the viewer and resolves when it closes.
 * @param {Options} opts
 */
export function serve(opts) {
  const token = randomBytes(18).toString('base64url')
  const server = createServer(handler(token))
  const port = Number(opts.port ?? 4711)

  return new Promise((done, fail) => {
    server.on('error', err => fail(err))
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const actual = typeof address === 'object' && address !== null ? address.port : port
      const url = `http://127.0.0.1:${actual}/?t=${token}`
      process.stdout.write(`session-recap viewer: ${url}\nCtrl+C to stop.\n`)
      if (!opts.noOpen) openBrowser(url)
    })
    server.on('close', () => done(undefined))
  })
}
