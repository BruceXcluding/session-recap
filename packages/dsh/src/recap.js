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

import { writeRecap } from '../vendor/core/recap.mjs'

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
async function currentRow(agent, deps) {
  const id = agent?.session?.id ?? agent?.id
  if (!id) return null
  const rows = await deps.python(['find', String(id)])
  return rows.find(r => r.agent === 'dsh' && r.id === id) ?? null
}

/**
 * Recaps one session: the one named by `query` (id or title words), else the
 * one dsh is running. Resolves `{ text, session, cached }`.
 */
export async function recap({ query, refresh, agent, llm, config, chatText, onProgress }, deps = { python }) {
  const session = query && query.trim() !== '' ? (await deps.python(['find', query]))[0] : await currentRow(agent, deps)
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

/** The `/recap [session]` command. */
export function recapCommand({ chatText, llm, config }) {
  return {
    name: 'recap',
    description: 'Recap this session (or one named after /recap): intent, decisions, changes, open threads, next step',
    // Declared so `/recap <words>` is a command, not a message to the model.
    input: { hint: 'title words or a session id; empty for this session' },
    handler: async invocation => {
      try {
        const r = await recap({
          query: typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : undefined,
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
