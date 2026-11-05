#!/usr/bin/env node
// session-recap: recap any AI coding session from the command line.
// Reads sessions with hooks/digest.py, writes the recap with core/recap.mjs,
// and calls the model the person configured (Anthropic or OpenAI-compatible).

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CHUNK_CHARS, formatText, splitParts, splitRecap, writeRecap } from '../core/recap.mjs'

/** @typedef {import('../core/recap.mjs').CompleteRequest} CompleteRequest */
/** @typedef {import('../core/recap.mjs').Digest} Digest */
/** @typedef {import('../core/recap.mjs').NoteCache} NoteCache */
/** @typedef {import('../core/recap.mjs').Progress} Progress */
/** @typedef {'claude' | 'codex' | 'dsh' | 'opencode'} Agent */

/**
 * A session as digest.py lists it.
 * @typedef {object} Session
 * @property {Agent} agent
 * @property {string} id
 * @property {string} path
 * @property {string} cwd
 * @property {string} title
 * @property {number} size
 * @property {number} mtimeMs
 */

/** @typedef {{ cwd: string, sessions: number, mtimeMs: number, agents: Record<string, number> }} Project */

/**
 * @typedef {object} Options
 * @property {string[]} words
 * @property {string} [command]
 * @property {string} [agent]
 * @property {string} [model]
 * @property {string} [partModel]
 * @property {boolean} [refresh]
 * @property {boolean} [dryRun]
 * @property {boolean} [json]
 * @property {boolean} [help]
 * @property {boolean} [version]
 * @property {string} [port] the viewer's port (serve)
 * @property {boolean} [noOpen] do not open a browser (serve)
 * @property {string} [format] a recap format other than the default
 */

/**
 * @typedef {object} ModelConfig
 * @property {string} [api] `anthropic`, else OpenAI-compatible
 * @property {string} [baseUrl]
 * @property {string} [apiKey]
 * @property {boolean} [bearer] send the key as a bearer token (ANTHROPIC_AUTH_TOKEN)
 * @property {string} [model]
 * @property {string} [partModel]
 * @property {string} [source] where the settings came from, for `config`
 */

/** @typedef {{ calls: number, input: number, output: number }} Usage */
/** @typedef {{ size: number, mtimeMs: number, at: number, prompts?: number, markdown: string, model?: string }} CachedRecap */

/**
 * The part of `fetch` this uses, so tests can stand in for it.
 * @typedef {(url: string, init: { method: string, headers: Record<string, string>, body: string }) =>
 *   Promise<{ ok: boolean, status: number, text: () => Promise<string> }>} Fetch
 */

/**
 * @typedef {{ ok: true, text: string, input: number, output: number }
 *   | { ok: false, status: number, error: string }} CallResult
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIGEST = join(ROOT, 'hooks', 'digest.py')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
/** @type {Agent[]} */
export const AGENTS = ['claude', 'codex', 'dsh', 'opencode']
/** @type {Record<string, string>} */
export const LABEL = { claude: 'Claude Code', codex: 'Codex', dsh: 'dsh', opencode: 'OpenCode' }
const COMMANDS = ['list', 'projects', 'install', 'config', 'models', 'mcp', 'mcp-config', 'serve', 'recap']
// Settings `config set` writes; the key is read from stdin, never the command line.
const SETTABLE = ['model', 'partModel', 'api', 'baseUrl', 'apiKey']
const PARALLEL = 4
const RETRIES = 2

// `session-recap list | head` closes the pipe early: that is not an error.
process.stdout.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
  if (err.code === 'EPIPE') process.exit(0)
  throw err
})

const HELP = `session-recap ${VERSION}: recap AI coding sessions (Claude Code, Codex, dsh, OpenCode)

Usage
  session-recap [words]          recap the session whose title or id holds the words;
                                 with none, the newest session in this folder
  session-recap list [words]     list sessions, newest first
  session-recap projects         list project folders and their sessions per agent
  session-recap install          add the session-recap skill to Codex, OpenCode and ~/.agents
  session-recap config           show the model settings in use
  session-recap config set <key> <value>
                                 save a setting: model, partModel, api, baseUrl, or
                                 apiKey (read from stdin: echo $KEY | session-recap config set apiKey -)
  session-recap config unset <key>
  session-recap models           list the models your provider offers; marks the ones in use
  session-recap mcp              run as an MCP server (stdio) for any MCP client
  session-recap mcp-config <client>
                                 print the MCP entry for claude, codex, cursor, gemini,
                                 opencode, zed, vscode or cline (no client: all of them)
  session-recap serve            open the local viewer (projects, sessions, Recap and Map)

Options
  --agent <name>    claude, codex, dsh, opencode, or auto (the agent running this; the default)
  --all             every agent's sessions (list); the same as --agent any
  --port <n>        the viewer's port (serve; default 4711)
  --no-open         start the viewer without opening a browser
  --format <name>   recap (default), standup, handoff or pr; only recap is cached
  --refresh         write the recap again from the start instead of updating it
  --dry-run         show what would be sent to the model, and its size, without calling it
  --json            print JSON instead of Markdown
  --model <id>      model for the recap        (env SESSION_RECAP_MODEL)
  --part-model <id> model for condensing parts of long sessions (env SESSION_RECAP_PART_MODEL)

Model settings: SESSION_RECAP_API (anthropic | openai), SESSION_RECAP_BASE_URL,
SESSION_RECAP_API_KEY, or ~/.config/session-recap/config.json with the same names in
camelCase. Without them it uses ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (+ ANTHROPIC_BASE_URL),
DEEPSEEK_API_KEY, or OPENAI_API_KEY, whichever is set.`

// ---------------------------------------------------------------- arguments

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
  /** @type {Options} */
  const opts = { words: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    const value = () => argv[++i] ?? fail(`${a} needs a value`)
    if (a === '--agent') opts.agent = value()
    else if (a === '--model') opts.model = value()
    else if (a === '--part-model') opts.partModel = value()
    else if (a === '--all') opts.agent = 'any'
    else if (a === '--refresh') opts.refresh = true
    else if (a === '--port') opts.port = value()
    else if (a === '--no-open') opts.noOpen = true
    else if (a === '--format') opts.format = value()
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--json') opts.json = true
    else if (a === '-h' || a === '--help') opts.help = true
    else if (a === '-v' || a === '--version') opts.version = true
    else if (a.startsWith('--')) fail(`unknown option ${a}`)
    else opts.words.push(a)
  }
  opts.command = COMMANDS.includes(opts.words[0] ?? '') ? opts.words.shift() : 'recap'

  return opts
}

/**
 * @param {string} message
 * @param {number} [code]
 * @returns {never}
 */
function fail(message, code = 1) {
  process.stderr.write(`session-recap: ${message}\n`)
  process.exit(code)
}

// ---------------------------------------------------------------- digest.py

/**
 * Runs hooks/digest.py and parses what it prints.
 * @param {string[]} args
 * @returns {any}
 */
export function python(args) {
  const tries = process.platform === 'win32' ? ['python', 'py'] : ['python3', '/usr/bin/python3']
  let last = ''
  for (const exe of tries) {
    const r = spawnSync(exe, ['-I', DIGEST, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (r.error) {
      last = r.error.message
      continue
    }
    if (r.status === 0) return JSON.parse(r.stdout)
    last = (r.stderr || '').trim().split('\n').at(-1) || `exit ${r.status}`
  }
  throw new Error(`digest.py failed: ${last}`)
}

// Variables a person may export in their own shell profile: they say where
// an agent keeps its files, not that this runs inside it.
const SETTINGS_VARS = new Set(['CODEX_HOME', 'DSH_HOME'])

/**
 * The agent this runs inside, from the markers each one sets for its tools.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Agent | 'any'}
 */
export function detectAgent(env = process.env) {
  const has = (/** @type {string} */ prefix) =>
    Object.keys(env).some(k => k.startsWith(prefix) && !SETTINGS_VARS.has(k))
  if (env.CLAUDECODE === '1') return 'claude'
  if (has('CODEX_')) return 'codex'
  if (env.OPENCODE !== undefined || env.OPENCODE_BIN_PATH !== undefined) return 'opencode'
  if (has('DSH_')) return 'dsh'
  return 'any'
}

/**
 * The session to recap: the one the words name, else the newest one here.
 * @param {Options} opts
 * @returns {Session}
 */
function pickSession(opts) {
  const agent = opts.agent === undefined || opts.agent === 'auto' ? detectAgent() : opts.agent
  if (agent !== 'any' && !AGENTS.includes(/** @type {Agent} */ (agent))) {
    fail(`unknown agent "${agent}" (${AGENTS.join(', ')})`)
  }
  if (opts.words.length === 0) {
    /** @type {Session | null} */
    const row = python(['current', agent, process.cwd()])
    return row ?? fail(`no ${agent === 'any' ? '' : `${LABEL[agent]} `}session found in ${process.cwd()} or above it`)
  }
  const query = opts.words.join(' ')
  /** @type {Session[]} */
  const rows = python(['find', query]).filter((/** @type {Session} */ r) => agent === 'any' || r.agent === agent)
  const [first, ...others] = rows
  if (first === undefined) return fail(`no session matches "${query}"; try: session-recap list`)
  if (others.length > 0) {
    process.stderr.write(`${rows.length} sessions match; recapping the newest. Others:\n`)
    for (const r of others.slice(0, 5)) process.stderr.write(`  ${LABEL[r.agent]} · ${r.title} (${r.id})\n`)
  }
  return first
}

// ---------------------------------------------------------------- config

function configPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'session-recap', 'config.json')
}

/**
 * The model settings: session-recap's own (flags, environment, config file),
 * else those of a provider whose key is in the environment.
 * @param {{ model?: string, partModel?: string }} [opts]
 * @param {Record<string, string | undefined>} [env]
 * @returns {ModelConfig}
 */
export function modelConfig(opts = {}, env = process.env) {
  /** @type {Record<string, string | undefined>} */
  let file = {}
  try {
    file = JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    // No config file, or one that is not JSON: flags and environment only.
  }
  /** @type {(flag: string | undefined, envName: string, fileName: string) => string | undefined} */
  const pick = (flag, envName, fileName) => flag ?? env[envName] ?? file[fileName]
  const explicit = {
    api: pick(undefined, 'SESSION_RECAP_API', 'api'),
    baseUrl: pick(undefined, 'SESSION_RECAP_BASE_URL', 'baseUrl'),
    apiKey: pick(undefined, 'SESSION_RECAP_API_KEY', 'apiKey'),
    model: pick(opts.model, 'SESSION_RECAP_MODEL', 'model'),
    partModel: pick(opts.partModel, 'SESSION_RECAP_PART_MODEL', 'partModel'),
  }
  // A key or base URL of session-recap's own starts a provider of its own;
  // without one, only the model names apply on top of the detected provider,
  // so its protocol, endpoint and key stay together.
  const isExplicit = explicit.apiKey !== undefined || explicit.baseUrl !== undefined
  /** @type {ModelConfig} */
  const merged = isExplicit ? { api: 'openai', source: 'session-recap settings' } : detectedProvider(env)
  /** @type {(keyof typeof explicit)[]} */
  const applies = isExplicit ? ['api', 'baseUrl', 'apiKey', 'model', 'partModel'] : ['model', 'partModel']
  for (const k of applies) if (explicit[k] !== undefined) merged[k] = explicit[k]
  merged.partModel = merged.partModel || merged.model

  return merged
}

/**
 * The provider whose key is in the environment, first found wins.
 * @param {Record<string, string | undefined>} env
 * @returns {ModelConfig}
 */
function detectedProvider(env) {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
    return {
      api: 'anthropic',
      baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      apiKey: env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN,
      bearer: !env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      partModel: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'claude-haiku-5-5',
      source: 'ANTHROPIC_* environment',
    }
  }
  if (env.DEEPSEEK_API_KEY) {
    return {
      api: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: env.DEEPSEEK_API_KEY,
      model: 'deepseek-chat',
      source: 'DEEPSEEK_API_KEY',
    }
  }
  if (env.OPENAI_API_KEY) {
    return {
      api: 'openai',
      baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      source: 'OPENAI_API_KEY',
    }
  }
  return {}
}

/** @param {string | undefined} key */
function masked(key) {
  return key ? `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)` : '(none)'
}

// ---------------------------------------------------------------- model calls

/**
 * One model call per request, at most PARALLEL at once, retrying 429 and 5xx.
 * @param {ModelConfig} config
 * @param {Usage} usage counts calls and tokens as they come back
 * @param {Fetch} [fetchImpl]
 * @returns {(request: CompleteRequest) => Promise<string>}
 */
export function makeComplete(config, usage, fetchImpl = /** @type {Fetch} */ (/** @type {unknown} */ (fetch))) {
  let running = 0
  /** @type {(() => void)[]} */
  const waiting = []
  /** @returns {Promise<void>} */
  const acquire = () =>
    new Promise(go => {
      const tryGo = () => {
        if (running < PARALLEL) {
          running += 1
          go()
        } else waiting.push(tryGo)
      }
      tryGo()
    })
  const release = () => {
    running -= 1
    waiting.shift()?.()
  }

  return async ({ stage, system, prompt, maxTokens }) => {
    const model = (stage === 'part' ? config.partModel : config.model) ?? ''
    await acquire()
    try {
      for (let attempt = 0; ; attempt++) {
        const r = await call(config, model, system, prompt, maxTokens, fetchImpl)
        if (r.ok) {
          usage.calls += 1
          usage.input += r.input
          usage.output += r.output
          return r.text
        }
        const isRetryable = r.status === 429 || r.status >= 500
        if (!isRetryable || attempt >= RETRIES) throw new Error(`${model}: HTTP ${r.status} ${r.error}`)
        await new Promise(done => setTimeout(done, 2000 * (attempt + 1)))
      }
    } finally {
      release()
    }
  }
}

/**
 * @param {ModelConfig} config
 * @param {string} model
 * @param {string} system
 * @param {string} prompt
 * @param {number} maxTokens
 * @param {Fetch} fetchImpl
 * @returns {Promise<CallResult>}
 */
async function call(config, model, system, prompt, maxTokens, fetchImpl) {
  const base = (config.baseUrl ?? '').replace(/\/+$/, '')
  const key = config.apiKey ?? ''
  const isAnthropic = config.api === 'anthropic'
  const res = isAnthropic
    ? await fetchImpl(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(config.bearer ? { authorization: `Bearer ${key}` } : { 'x-api-key': key }),
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
      })
    : await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        }),
      })
  const body = await res.text()
  if (!res.ok) return { ok: false, status: res.status, error: body.slice(0, 300) }
  const data = JSON.parse(body)
  if (isAnthropic) {
    /** @type {{ type: string, text?: string }[]} */
    const blocks = data.content ?? []
    const text = blocks
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('')
    return { ok: true, text, input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 }
  }
  const text = data.choices?.[0]?.message?.content ?? ''
  return { ok: true, text, input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 }
}

// ---------------------------------------------------------------- caches

/** @param {...string} parts */
export function cacheDir(...parts) {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  const dir = join(base, 'session-recap', ...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * @param {string} path
 * @returns {any}
 */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Part notes as files, one per content hash. @type {NoteCache} */
export const noteFiles = {
  get: key => {
    const path = join(cacheDir('notes'), `${key}.txt`)
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  },
  set: (key, note) => writeFileSync(join(cacheDir('notes'), `${key}.txt`), note),
}

/**
 * Characters to tokens: about one token per CJK character, four characters per token otherwise.
 * @param {string} text
 */
export function estimateTokens(text) {
  const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length
  return Math.round(cjk + (text.length - cjk) / 4)
}

/** @param {number} ms */
function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60_000)
  if (min < 60) return `${Math.max(0, min)}m ago`
  if (min < 48 * 60) return `${Math.round(min / 60)}h ago`
  return `${Math.round(min / 1440)}d ago`
}

// ---------------------------------------------------------------- commands

/**
 * Where a session's recap is cached; the CLI, the MCP server and the viewer share it.
 * @param {Session} session
 */
export function recapPath(session) {
  return join(cacheDir('recaps'), `${session.agent}-${session.id.replace(/[^\w.-]/g, '_')}.json`)
}

/**
 * Recaps the Claude Code plugin wrote: its store is a JSON object of
 * `recap:<agent>:<id>` entries under the Claude configuration folder. Read
 * only, and best effort: a store this cannot read is no store.
 * @param {Session} session
 * @returns {CachedRecap | undefined}
 */
function pluginRecap(session) {
  const dir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins', 'store')
  /** @type {CachedRecap | undefined} */
  let best
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('session-recap_') || !name.endsWith('.json')) continue
      const store = readJson(join(dir, name)) ?? {}
      const found =
        store[`recap:${session.agent}:${session.id}`] ??
        (session.agent === 'claude' ? store[`recap:${session.id}`] : undefined)
      if (found && typeof found.markdown === 'string' && (best === undefined || (found.at ?? 0) > best.at)) best = found
    }
  } catch {
    // No Claude Code, or no plugin store yet.
  }
  return best
}

/**
 * The newest recap of `session`: the shared cache's, or the Claude Code plugin's.
 * @param {Session} session
 * @returns {CachedRecap | undefined}
 */
export function readCached(session) {
  /** @type {CachedRecap | undefined} */
  const own = readJson(recapPath(session))
  const plugin = pluginRecap(session)
  if (own === undefined) return plugin
  return plugin !== undefined && (plugin.at ?? 0) > (own.at ?? 0) ? plugin : own
}

/**
 * Saves a recap of `session` as it stands, covering its first `prompts` prompts.
 * @param {Session} session
 * @param {number} prompts
 * @param {string} markdown
 * @param {string} [model]
 */
export function saveCached(session, prompts, markdown, model) {
  /** @type {CachedRecap} */
  const saved = { size: session.size, mtimeMs: session.mtimeMs, at: Date.now(), prompts, markdown, model }
  writeFileSync(recapPath(session), JSON.stringify(saved))
  return saved
}

/**
 * @param {CachedRecap | undefined} recap
 * @param {Session} session
 */
export function isFreshFor(recap, session) {
  return recap !== undefined && recap.size === session.size && recap.mtimeMs === session.mtimeMs
}

/** @param {Options} opts */
async function recap(opts) {
  const session = pickSession(opts)
  const format = opts.format ?? 'recap'
  formatText(format)
  // Another format is written whole each time and not cached: the cache holds recaps.
  /** @type {CachedRecap | undefined} */
  const previous = opts.refresh || format !== 'recap' ? undefined : readCached(session)
  const isFresh = isFreshFor(previous, session)
  // A recap that knows how many prompts it covers is brought up to date from there.
  const from = previous?.prompts !== undefined && !isFresh ? previous.prompts : 0
  /** @type {Usage} */
  const usage = { calls: 0, input: 0, output: 0 }
  let markdown = previous?.markdown ?? ''

  if (!isFresh) {
    /** @type {Digest} */
    const digest = python(['digest', session.agent, session.path, String(from)])
    if (opts.dryRun) return printDryRun(opts, session, digest, from)
    const config = modelConfig(opts)
    if (!config.apiKey || !config.baseUrl) {
      fail(
        'no model configured. Set SESSION_RECAP_API_KEY (and SESSION_RECAP_BASE_URL, SESSION_RECAP_MODEL), ' +
          'or ANTHROPIC_API_KEY, DEEPSEEK_API_KEY or OPENAI_API_KEY. See: session-recap --help',
        2,
      )
    }
    if (!config.model) fail('no model name: set SESSION_RECAP_MODEL or pass --model', 2)
    /** @param {Progress} p */
    const progress = ({ step, done, total }) => {
      if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${total ? `[${done}/${total}] ` : ''}${step}…`)
    }
    markdown = await writeRecap({
      digest,
      previous: from > 0 ? previous : undefined,
      complete: makeComplete(config, usage),
      notes: noteFiles,
      progress,
      format,
    })
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[2K')
    if (format === 'recap') saveCached(session, digest.prompts, markdown, config.model)
  }

  if (opts.json) {
    // The recap's Markdown, and its map as data (null when the model wrote none).
    const { markdown: text, map } = splitRecap(markdown)
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, format, session, markdown: text, map: map ?? null, cached: isFresh, usage })}\n`,
    )
    return
  }
  const meta = [
    LABEL[session.agent],
    session.cwd,
    `active ${ago(session.mtimeMs)}`,
    isFresh ? 'cached recap' : 'new recap',
  ]
  process.stdout.write(`# ${session.title}\n\n> ${meta.join(' · ')}\n\n${splitRecap(markdown).markdown}\n`)
  if (usage.calls > 0) {
    const calls = `${usage.calls} model call${usage.calls === 1 ? '' : 's'}`
    const update = from > 0 ? ` · updated from prompt ${from + 1}` : ''
    process.stderr.write(`\n${calls} · ${usage.input} input / ${usage.output} output tokens${update}\n`)
  }
}

/**
 * What a recap would send, without sending it.
 * @param {Options} opts
 * @param {Session} session
 * @param {Digest} digest
 * @param {number} from
 */
function printDryRun(opts, session, digest, from) {
  const parts = splitParts(digest.text, CHUNK_CHARS)
  const report = {
    session: `${LABEL[session.agent]} · ${session.title}`,
    mode: from > 0 ? `update from prompt ${from + 1}` : 'full recap',
    prompts: digest.prompts,
    characters: digest.text.length,
    estimatedInputTokens: estimateTokens(digest.text),
    modelCalls: parts.length > 1 ? parts.length + 1 : 1,
    secretsRemoved: digest.redactions ?? 0,
  }
  const text = opts.json
    ? JSON.stringify(report)
    : Object.entries(report)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
  process.stdout.write(`${text}\n`)
}

/** @param {Options} opts */
function list(opts) {
  // Inside an agent, its own sessions; from a plain shell, or with --all, every agent's.
  const agent = opts.agent === undefined || opts.agent === 'auto' ? detectAgent() : opts.agent
  const query = opts.words.join(' ')
  /** @type {Session[]} */
  const rows = python(query ? ['find', query] : ['all']).filter(
    (/** @type {Session} */ r) => agent === 'any' || r.agent === agent,
  )
  if (opts.json) return process.stdout.write(`${JSON.stringify(rows)}\n`)
  for (const r of rows) {
    const label = (LABEL[r.agent] ?? r.agent).padEnd(11)
    process.stdout.write(`${label} ${ago(r.mtimeMs).padStart(8)}  ${r.title}\n${' '.repeat(22)}${r.cwd}  (${r.id})\n`)
  }
}

/** @param {Options} opts */
function projects(opts) {
  /** @type {Project[]} */
  const rows = python(['projects'])
  if (opts.json) return process.stdout.write(`${JSON.stringify(rows)}\n`)
  for (const p of rows) {
    const agents = Object.entries(p.agents)
      .map(([a, n]) => `${LABEL[a] ?? a} ${n}`)
      .join(' · ')
    process.stdout.write(`${p.cwd}\n  ${agents} · ${ago(p.mtimeMs)}\n`)
  }
}

// Desktop agents often run tools without the shell profile's PATH, so the
// skill names this install's full command as well.
const FULL_COMMAND = `"${process.execPath}" "${fileURLToPath(import.meta.url)}"`

/**
 * The SKILL.md that tells an agent how to run session-recap.
 * @param {Agent | 'any'} agent
 * @param {string} [full] the command by its full path
 */
export function skillText(agent, full = FULL_COMMAND) {
  const flag = agent === 'any' ? '' : ` --agent ${agent}`
  return `---
name: session-recap
description: Recap an AI coding session - its intent, key decisions, what changed, open threads and where to resume. Use when the person asks to recap, summarize or be reminded of this session or an earlier one ("what was this session about", "where were we", "recap", "总结一下这个会话", "我们做到哪了").
---

# session-recap

1. In the project folder, run:

   \`\`\`bash
   session-recap${flag}
   \`\`\`

   If the shell says \`session-recap\` is not found, run it by its full path instead:

   \`\`\`bash
   ${full}${flag}
   \`\`\`

   For an earlier session, find it with \`session-recap list <words>\` and run \`session-recap${flag} "<title words>"\`.
2. Show the person the recap exactly as printed (it is Markdown). Do not summarize it again.
3. If it reports that no model is configured, tell the person to set \`SESSION_RECAP_API_KEY\`, \`SESSION_RECAP_BASE_URL\` and \`SESSION_RECAP_MODEL\` (see \`session-recap --help\`), and do not write a recap yourself from memory.
`
}

/** @param {Options} opts */
function install(opts) {
  const home = homedir()
  const codexHome = process.env.CODEX_HOME || join(home, '.codex')
  /** @type {{ name: string, agent: Agent | 'any', dir: string, when: string }[]} */
  const targets = [
    { name: 'codex', agent: 'codex', dir: join(codexHome, 'skills'), when: codexHome },
    {
      name: 'opencode',
      agent: 'opencode',
      dir: join(home, '.config', 'opencode', 'skills'),
      when: join(home, '.config', 'opencode'),
    },
    // The shared skills folder several agents read (dsh among them where it supports skills).
    { name: 'agents', agent: 'any', dir: join(home, '.agents', 'skills'), when: home },
  ]
  const wanted = opts.words.length > 0 ? opts.words : null
  for (const t of targets) {
    if (wanted && !wanted.includes(t.name)) continue
    if (!existsSync(t.when)) {
      process.stdout.write(`skip ${t.name}: ${t.when} not found\n`)
      continue
    }
    const dir = join(t.dir, 'session-recap')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), skillText(t.agent))
    process.stdout.write(`installed ${join(dir, 'SKILL.md')}\n`)
  }
  process.stdout.write(
    'Claude Code: install the plugin instead: /plugin install session-recap --marketplace BruceXcluding/session-recap\n',
  )
}

/** @returns {Record<string, string>} */
function readConfigFile() {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

/** @param {Record<string, string>} values */
function writeConfigFile(values) {
  mkdirSync(dirname(configPath()), { recursive: true })
  writeFileSync(configPath(), `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 })
  // An existing file keeps its mode on write: the key must not be readable by others.
  chmodSync(configPath(), 0o600)
}

/**
 * `config set <key> <value>`, `config unset <key>`, or (no words) the settings in use.
 * @param {Options} opts
 */
function config(opts) {
  const [action, key, value] = opts.words
  if (action === undefined) return showConfig(opts)
  if (action !== 'set' && action !== 'unset')
    fail(`config ${action}: use "config set <key> <value>" or "config unset <key>"`)
  if (key === undefined || !SETTABLE.includes(key)) fail(`config ${action} takes one of: ${SETTABLE.join(', ')}`)
  const values = readConfigFile()
  if (action === 'unset') {
    delete values[key]
  } else {
    if (key === 'apiKey' && value !== '-')
      fail('read the key from stdin, so it stays out of shell history: echo "$KEY" | session-recap config set apiKey -')
    const given = value === '-' ? readFileSync(0, 'utf8').trim() : value
    if (given === undefined || given === '') fail(`config set ${key} needs a value`)
    if (key === 'api' && given !== 'anthropic' && given !== 'openai') fail('api is "anthropic" or "openai"')
    values[key] = given
  }
  writeConfigFile(values)
  process.stdout.write(`${action === 'set' ? 'saved' : 'removed'} ${key} in ${configPath()}\n`)
}

/**
 * The models the configured provider lists (GET /models), the ones in use marked.
 * @param {Options} opts
 * @param {(url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean, status: number, text: () => Promise<string> }>} [fetchImpl]
 */
export async function models(opts, fetchImpl = /** @type {any} */ (fetch)) {
  const c = modelConfig(opts)
  if (!c.apiKey || !c.baseUrl) fail('no model provider configured; see: session-recap --help', 2)
  const base = c.baseUrl.replace(/\/+$/, '')
  const isAnthropic = c.api === 'anthropic'
  const res = await fetchImpl(isAnthropic ? `${base}/v1/models?limit=100` : `${base}/models`, {
    headers: isAnthropic
      ? {
          'anthropic-version': '2023-06-01',
          ...(c.bearer ? { authorization: `Bearer ${c.apiKey}` } : { 'x-api-key': c.apiKey }),
        }
      : { authorization: `Bearer ${c.apiKey}` },
  })
  const body = await res.text()
  if (!res.ok) fail(`${base} answered HTTP ${res.status} when asked for its models: ${body.slice(0, 200)}`)
  /** @type {{ id: string }[]} */
  const listed = JSON.parse(body).data ?? []
  const ids = listed.map(m => m.id).sort()
  if (opts.json)
    return process.stdout.write(`${JSON.stringify({ models: ids, model: c.model, partModel: c.partModel })}\n`)
  for (const id of ids) {
    const marks = [id === c.model ? 'recap' : '', id === c.partModel ? 'parts' : ''].filter(Boolean)
    process.stdout.write(`${marks.length > 0 ? '●' : ' '} ${id}${marks.length > 0 ? `   ← ${marks.join(', ')}` : ''}\n`)
  }
  for (const [name, id] of [
    ['recap', c.model],
    ['parts', c.partModel],
  ]) {
    if (id && !ids.includes(id)) process.stdout.write(`! ${name} model "${id}" is not in this list\n`)
  }
  process.stdout.write('\nPick one: session-recap config set model <id>   (parts: config set partModel <id>)\n')
}

/**
 * This Node's path as PATH names it (`/opt/homebrew/bin/node`), when PATH has
 * the same binary: a versioned path (`…/Cellar/node/26.8.1/bin/node`) would
 * break every MCP entry at the next upgrade.
 */
function stableNode() {
  const real = realpathSync(process.execPath)
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    const candidate = join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
    try {
      if (dir !== '' && realpathSync(candidate) === real) return candidate
    } catch {
      // Not in this folder.
    }
  }
  return process.execPath
}

/**
 * The MCP entry for each client, with absolute paths: an IDE launched from the
 * dock does not see the shell's PATH.
 * @param {Options} opts
 */
function mcpConfig(opts) {
  const command = stableNode()
  const args = [fileURLToPath(import.meta.url), 'mcp']
  const json = (/** @type {unknown} */ v) => JSON.stringify(v, null, 2)
  const server = { command, args }
  /** @type {Record<string, { where: string, text: string }>} */
  const clients = {
    claude: {
      where: 'run in a shell',
      text: `claude mcp add --scope user session-recap -- "${command}" "${args[0]}" mcp`,
    },
    codex: {
      where: '~/.codex/config.toml',
      text: `[mcp_servers.session-recap]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}`,
    },
    cursor: { where: '~/.cursor/mcp.json', text: json({ mcpServers: { 'session-recap': server } }) },
    gemini: {
      where: '~/.gemini/settings.json (also Qwen Code: ~/.qwen/settings.json)',
      text: json({ mcpServers: { 'session-recap': server } }),
    },
    opencode: {
      where: '~/.config/opencode/opencode.json',
      text: json({ mcp: { 'session-recap': { type: 'local', command: [command, ...args], enabled: true } } }),
    },
    zed: {
      where: 'Zed settings.json',
      text: json({ context_servers: { 'session-recap': { command: { path: command, args } } } }),
    },
    vscode: {
      where: '.vscode/mcp.json, or the user mcp.json',
      text: json({ servers: { 'session-recap': { type: 'stdio', ...server } } }),
    },
    cline: {
      where: "Cline's cline_mcp_settings.json",
      text: json({ mcpServers: { 'session-recap': { ...server, disabled: false } } }),
    },
  }
  const wanted = opts.words[0]
  if (wanted !== undefined && clients[wanted] === undefined)
    fail(`no MCP entry for "${wanted}"; one of: ${Object.keys(clients).join(', ')}`)
  for (const [name, c] of Object.entries(clients)) {
    if (wanted !== undefined && name !== wanted) continue
    process.stdout.write(
      `${wanted === undefined ? `## ${name} · ${c.where}\n` : ''}${c.text}\n${wanted === undefined ? '\n' : ''}`,
    )
  }
}

/** @param {Options} opts */
function showConfig(opts) {
  const c = modelConfig(opts)
  const lines = [
    `source:      ${c.source ?? '(none)'}`,
    `api:         ${c.api ?? '(none)'}`,
    `base URL:    ${c.baseUrl ?? '(none)'}`,
    `API key:     ${masked(c.apiKey)}`,
    `model:       ${c.model ?? '(none)'}`,
    `part model:  ${c.partModel ?? '(none)'}`,
    `config file: ${configPath()}${existsSync(configPath()) ? '' : ' (not present)'}`,
    `agent here:  ${detectAgent()}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

/** @param {string[]} argv */
export async function main(argv) {
  const opts = parseArgs(argv)
  if (opts.help) return process.stdout.write(`${HELP}\n`)
  if (opts.version) return process.stdout.write(`${VERSION}\n`)
  if (opts.command === 'list') return list(opts)
  if (opts.command === 'projects') return projects(opts)
  if (opts.command === 'install') return install(opts)
  if (opts.command === 'config') return config(opts)
  if (opts.command === 'models') return models(opts)
  if (opts.command === 'mcp') {
    // Loaded here, not at the top: the server imports this module.
    const { serveMcp } = await import('./mcp.mjs')
    return serveMcp(VERSION)
  }
  if (opts.command === 'mcp-config') return mcpConfig(opts)
  if (opts.command === 'serve') {
    const { serve } = await import('./serve.mjs')
    return serve(opts)
  }
  return recap(opts)
}

// Run as a command (npm links the bin, so compare real paths), not when imported by tests.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(err => fail(err instanceof Error ? err.message : String(err)))
}
