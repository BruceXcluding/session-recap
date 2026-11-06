// The dsh plugin's work, apart from dsh's own packages so it can be tested
// without a dsh host: index.js hands in `defineTool` and `chatText`.
//
// Sessions are read by vendor/digest.py, recaps written by vendor/core/recap.mjs
// (both copied from the session-recap repository when the package is built),
// and kept in the cache the session-recap CLI, MCP server and viewer share.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { splitRecap, writeRecap } from '../vendor/core/recap.mjs'
import { sectionsOf } from '../vendor/core/sections.mjs'

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor')
const DIGEST = join(VENDOR, 'digest.py')
const LABEL = { claude: 'Claude Code', codex: 'Codex', dsh: 'dsh', opencode: 'OpenCode' }

/** Runs digest.py and parses what it prints. */
export function python(args, { digest = DIGEST } = {}) {
  const tries = process.platform === 'win32' ? ['python', 'py'] : ['python3', '/usr/bin/python3']
  return new Promise((resolve, reject) => {
    const attempt = i => {
      if (i >= tries.length) return reject(new Error('python3 was not found; session-recap needs it to read sessions'))
      const child = spawn(tries[i], ['-I', digest, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', c => (out += c))
      child.stderr.on('data', c => (err += c))
      child.on('error', () => attempt(i + 1))
      child.on('close', code => {
        if (code === 0) return resolve(JSON.parse(out))
        reject(new Error(`digest.py failed: ${err.trim().split('\n').at(-1) || `exit ${code}`}`))
      })
    }
    attempt(0)
  })
}

// ------------------------------------------------------------ the shared cache

function cacheDir() {
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'session-recap', 'recaps')
  mkdirSync(dir, { recursive: true })
  return dir
}

const recapPath = s => join(cacheDir(), `${s.agent}-${s.id.replace(/[^\w.-]/g, '_')}.json`)

export function readCached(session) {
  const path = recapPath(session)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export function saveCached(session, prompts, markdown, model) {
  const saved = { size: session.size, mtimeMs: session.mtimeMs, at: Date.now(), prompts, markdown, model }
  writeFileSync(recapPath(session), JSON.stringify(saved))
  return saved
}

const isFresh = (recap, s) => recap !== undefined && recap.size === s.size && recap.mtimeMs === s.mtimeMs

/** Part notes cached by content hash, beside the recaps. */
const notes = {
  get: key => {
    const path = join(cacheDir(), '..', 'notes', `${key}.txt`)
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  },
  set: (key, note) => {
    const dir = join(cacheDir(), '..', 'notes')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${key}.txt`), note)
  },
}

// ------------------------------------------------------------ the host

/** The provider and model this session runs on, else the plugin's own setting. */
export function routeOf(session, config) {
  if (config?.provider && config?.model) return { provider: config.provider, model: config.model }
  try {
    const header = session?.requestHeader?.()?.config
    if (header?.provider && header?.model) return { provider: header.provider, model: header.model }
  } catch {
    // An older host without request headers.
  }
  return null
}

/** The session dsh is running, as digest.py lists it. */
async function currentRow(agent, deps, sessionId) {
  const id = agent?.session?.id ?? agent?.id ?? sessionId
  if (!id) return null
  const rows = await deps.python(['find', String(id)])
  return rows.find(r => r.agent === 'dsh' && r.id === id) ?? null
}

/**
 * Recaps one session: the one named by `query` (id or title words), else the
 * one dsh is running. Resolves `{ text, session, cached }`.
 */
export async function recap({ query, row, refresh, agent, llm, config, chatText, onProgress }, deps = { python }) {
  const session =
    row ?? (query && query.trim() !== '' ? (await deps.python(['find', query]))[0] : await currentRow(agent, deps))
  if (!session) {
    throw new Error(
      query ? `no session matches "${query}"` : 'this session has no saved transcript yet; try again after a turn',
    )
  }
  const previous = refresh ? undefined : readCached(session)
  const meta = `> ${LABEL[session.agent] ?? session.agent} · ${session.cwd}`
  if (isFresh(previous, session))
    return { text: render(session, previous.markdown, `${meta} · stored recap`), session, cached: true }

  const route = routeOf(agent?.session, config)
  if (route === null)
    throw new Error('no model route: set provider and model in the plugin config, or run it from a session')
  const from = previous?.prompts !== undefined ? previous.prompts : 0
  const digest = await deps.python(['digest', session.agent, session.path, String(from)])
  const markdown = await writeRecap({
    digest,
    previous: from > 0 ? previous : undefined,
    notes,
    progress: p => onProgress?.(p),
    complete: ({ system, prompt }) => chatText(llm, system, prompt, { route, timeoutMs: 300_000 }),
  })
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    throw new Error(`${route.model} returned no recap text`)
  }
  saveCached(session, digest.prompts, markdown, route.model)

  return { text: render(session, markdown, `${meta} · new recap by ${route.model}`), session, cached: false }
}

// The Markdown alone: the map's json block is data for viewers, not for the chat.
function render(session, raw, meta) {
  const at = raw.lastIndexOf('```json recap-map')
  const markdown = (at < 0 ? raw : raw.slice(0, at)).trim()

  return `# ${session.title}\n\n${meta}\n\n${markdown}`
}

/** The agent tool: `session_recap`. */
export function recapTool({ defineTool, chatText, llm, config }) {
  return defineTool({
    name: 'session_recap',
    description:
      'Recap a coding session: its intent, key decisions, what changed, open threads and where to resume. ' +
      'With no session given, the current one. Also finds Claude Code, Codex and OpenCode sessions by id or title words. ' +
      'Show the person the recap as returned.',
    parameters: {
      session: { type: 'string', description: 'A session id or words in its title; empty for this session' },
      refresh: { type: 'boolean', description: 'Write it again even if a stored recap is current' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const r = await recap({
        query: args?.session,
        refresh: args?.refresh === true,
        agent: exec?.agent,
        llm,
        config,
        chatText,
      })
      return r.text
    },
  })
}

// ------------------------------------------------------------ the side panel

// The dsh web panel (client/client.js) reads through an authenticated route,
// POST /api/session-recap/panel (see index.js), so reading writes nothing into
// the chat. A host without that route is asked through the command instead:
// `/recap --panel {"op": …}` answers with the same JSON as text.
export const PANEL_FLAG = '--panel'
export const PANEL_PATH = '/api/session-recap/panel'

const intentOf = markdown => {
  const intent = sectionsOf(splitRecap(markdown).markdown).intent ?? ''
  return intent.replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** A session row with what the cache knows about its recap. */
function marked(row, fresh) {
  const cached = readCached(row)
  return {
    agent: row.agent,
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    mtimeMs: row.mtimeMs,
    recap: cached?.markdown
      ? { fresh: fresh ?? isFresh(cached, row), at: cached.at, intent: intentOf(cached.markdown) }
      : null,
  }
}

/** A stored recap, split for drawing: Markdown, map and sections. */
function view(row, cached, fresh) {
  if (!cached?.markdown) return { session: marked(row), recap: null }
  const { markdown, map } = splitRecap(cached.markdown)
  return {
    session: marked(row, fresh),
    recap: { markdown, map: map ?? null, sections: sectionsOf(markdown), model: cached.model ?? null, at: cached.at },
  }
}

async function rowOf(agent, id, deps) {
  const rows = await deps.python(['find', String(id)])
  const row = rows.find(r => r.agent === agent && r.id === id)
  if (!row) throw new Error(`no ${agent} session ${id}`)
  return row
}

/** One panel request; resolves the JSON-ready answer. */
export async function panel(request, { agent, llm, config, chatText }, deps = { python }) {
  const op = request?.op
  if (op === 'home') {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : undefined
    const current = await currentRow(agent, deps, sessionId)
    const cwd = current?.cwd ?? (typeof request.cwd === 'string' ? request.cwd : null)
    const sessions = cwd ? (await deps.python(['sessions', cwd])).map(r => marked(r)) : []
    // The running session's file grows with every command, `/recap` included,
    // so its recap is current while no new prompt came after it.
    const cached = current ? readCached(current) : undefined
    let fresh
    if (cached?.markdown && !isFresh(cached, current) && typeof cached.prompts === 'number') {
      const { prompts } = await deps.python(['digest', current.agent, current.path, '0', '1000'])
      fresh = prompts === cached.prompts
    }
    if (fresh !== undefined) {
      const row = sessions.find(r => r.agent === current.agent && r.id === current.id)
      if (row?.recap) row.recap.fresh = fresh
    }
    return {
      current: current ? view(current, cached, fresh) : null,
      cwd,
      sessions,
      // From the route, the command runs in the session, on the session's model.
      canWrite: agent === undefined || routeOf(agent?.session, config) !== null,
    }
  }
  if (op === 'sessions') {
    if (typeof request.cwd !== 'string') throw new Error('sessions needs a cwd')
    return { cwd: request.cwd, sessions: (await deps.python(['sessions', request.cwd])).map(r => marked(r)) }
  }
  if (op === 'projects') return { projects: await deps.python(['projects']) }
  if (op === 'get') {
    const row = await rowOf(request.agent, request.id, deps)
    return view(row, readCached(row))
  }
  if (op === 'write') {
    const row = await rowOf(request.agent, request.id, deps)
    await recap({ row, refresh: request.refresh === true, agent, llm, config, chatText }, deps)
    return view(row, readCached(row))
  }
  throw new Error(`unknown panel request ${JSON.stringify(op)}`)
}

/** The panel's route: one JSON request in, `{ ok, value | error }` out. */
export function panelRoute(deps) {
  return {
    path: PANEL_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      let body
      try {
        const payload = await request.json()
        // Writing needs the session's model: the panel runs `/recap` in it instead.
        if (payload?.op === 'write') throw new Error('write a recap with /recap in the session')
        const value = await panel(payload, deps)
        body = { ok: true, value }
      } catch (err) {
        body = { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    },
  }
}

/** The `/recap [session]` command. */
export function recapCommand({ chatText, llm, config }) {
  return {
    name: 'recap',
    description: 'Recap this session (or one named after /recap): intent, decisions, changes, open threads, next step',
    // Declared so `/recap <words>` is a command, not a message to the model.
    input: { hint: 'title words or a session id; empty for this session; --refresh to write it again' },
    handler: async invocation => {
      const input = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
      if (input.startsWith(PANEL_FLAG)) {
        try {
          const request = JSON.parse(input.slice(PANEL_FLAG.length).trim() || '{}')
          const value = await panel(request, { agent: invocation?.agent, llm, config, chatText })
          return { kind: 'success', text: JSON.stringify({ ok: true, value }) }
        } catch (err) {
          return { kind: 'success', text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }
        }
      }
      const refresh = /^--refresh(\s|$)/.test(input)
      const query = refresh ? input.slice('--refresh'.length).trim() : input
      try {
        const r = await recap({
          query: query === '' ? undefined : query,
          refresh,
          agent: invocation?.agent,
          llm,
          config,
          chatText,
        })
        return { kind: 'success', text: r.text }
      } catch (err) {
        return { kind: 'error', text: `[recap] ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  }
}
