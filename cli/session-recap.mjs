#!/usr/bin/env node
// session-recap: recap any AI coding session from the command line.
// Reads sessions with hooks/digest.py, writes the recap with core/recap.mjs,
// and calls the model the person configured (Anthropic or OpenAI-compatible).

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CHUNK_CHARS, splitParts, writeRecap } from '../core/recap.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIGEST = join(ROOT, 'hooks', 'digest.py')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const AGENTS = ['claude', 'codex', 'dsh', 'opencode']
const LABEL = { claude: 'Claude Code', codex: 'Codex', dsh: 'dsh', opencode: 'OpenCode' }
const PARALLEL = 4

// `session-recap list | head` closes the pipe early: that is not an error.
process.stdout.on('error', err => {
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

Options
  --agent <name>    claude, codex, dsh, opencode, or auto (the agent running this; the default)
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

function parseArgs(argv) {
  const opts = { words: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) fail(`${a} needs a value`)
      return v
    }
    if (a === '--agent') opts.agent = value()
    else if (a === '--model') opts.model = value()
    else if (a === '--part-model') opts.partModel = value()
    else if (a === '--refresh') opts.refresh = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--json') opts.json = true
    else if (a === '-h' || a === '--help') opts.help = true
    else if (a === '-v' || a === '--version') opts.version = true
    else if (a.startsWith('--')) fail(`unknown option ${a}`)
    else opts.words.push(a)
  }
  const commands = ['list', 'projects', 'install', 'config', 'recap']
  opts.command = commands.includes(opts.words[0]) ? opts.words.shift() : 'recap'

  return opts
}

function fail(message, code = 1) {
  process.stderr.write(`session-recap: ${message}\n`)
  process.exit(code)
}

// ---------------------------------------------------------------- digest.py

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

// The agent this runs inside, from the markers each one sets for its tools.
export function detectAgent(env = process.env) {
  const set = prefix => Object.keys(env).some(k => k.startsWith(prefix) && !SETTINGS_VARS.has(k))
  if (env.CLAUDECODE === '1') return 'claude'
  if (set('CODEX_')) return 'codex'
  if (env.OPENCODE !== undefined || env.OPENCODE_BIN_PATH !== undefined) return 'opencode'
  if (set('DSH_')) return 'dsh'
  return 'any'
}

function pickSession(opts) {
  const agent = opts.agent === undefined || opts.agent === 'auto' ? detectAgent() : opts.agent
  if (agent !== 'any' && !AGENTS.includes(agent)) fail(`unknown agent "${agent}" (${AGENTS.join(', ')})`)
  if (opts.words.length === 0) {
    const row = python(['current', agent, process.cwd()])
    if (row === null) fail(`no ${agent === 'any' ? '' : `${LABEL[agent]} `}session found in ${process.cwd()} or above it`)
    return row
  }
  const query = opts.words.join(' ')
  const rows = python(['find', query]).filter(r => agent === 'any' || r.agent === agent)
  if (rows.length === 0) fail(`no session matches "${query}"; try: session-recap list`)
  if (rows.length > 1) {
    process.stderr.write(`${rows.length} sessions match; recapping the newest. Others:\n`)
    for (const r of rows.slice(1, 6)) process.stderr.write(`  ${LABEL[r.agent]} · ${r.title} (${r.id})\n`)
  }
  return rows[0]
}

// ---------------------------------------------------------------- config

function configPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'session-recap', 'config.json')
}

export function modelConfig(opts = {}, env = process.env) {
  let file = {}
  try {
    file = JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {}
  const pick = (flag, envName, fileName) => flag ?? env[envName] ?? file[fileName]
  const explicit = {
    api: pick(undefined, 'SESSION_RECAP_API', 'api'),
    baseUrl: pick(undefined, 'SESSION_RECAP_BASE_URL', 'baseUrl'),
    apiKey: pick(undefined, 'SESSION_RECAP_API_KEY', 'apiKey'),
    model: pick(opts.model, 'SESSION_RECAP_MODEL', 'model'),
    partModel: pick(opts.partModel, 'SESSION_RECAP_PART_MODEL', 'partModel'),
  }
  let auto = {}
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
    auto = {
      api: 'anthropic',
      baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      apiKey: env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN,
      bearer: !env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      partModel: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'claude-haiku-5-5',
      source: 'ANTHROPIC_* environment',
    }
  } else if (env.DEEPSEEK_API_KEY) {
    auto = {
      api: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: env.DEEPSEEK_API_KEY,
      model: 'deepseek-chat',
      source: 'DEEPSEEK_API_KEY',
    }
  } else if (env.OPENAI_API_KEY) {
    auto = {
      api: 'openai',
      baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      source: 'OPENAI_API_KEY',
    }
  }
  // A key or base URL of session-recap's own starts a provider of its own;
  // without one, only the model names apply on top of the detected provider,
  // so its protocol, endpoint and key stay together.
  const isExplicit = explicit.apiKey !== undefined || explicit.baseUrl !== undefined
  const base = isExplicit ? { api: 'openai', source: 'session-recap settings' } : auto
  const merged = { ...base }
  const applies = isExplicit ? Object.keys(explicit) : ['model', 'partModel']
  for (const k of applies) if (explicit[k] !== undefined) merged[k] = explicit[k]
  merged.partModel = merged.partModel || merged.model

  return merged
}

function masked(key) {
  return key ? `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)` : '(none)'
}

// ---------------------------------------------------------------- model calls

export function makeComplete(config, usage, fetchImpl = globalThis.fetch) {
  let running = 0
  const queue = []
  const slot = () =>
    new Promise(go => {
      const tryGo = () => {
        if (running < PARALLEL) {
          running += 1
          go()
        } else queue.push(tryGo)
      }
      tryGo()
    })
  const release = () => {
    running -= 1
    queue.shift()?.()
  }

  return async ({ stage, system, prompt, maxTokens }) => {
    const model = stage === 'part' ? config.partModel : config.model
    await slot()
    try {
      for (let attempt = 0; ; attempt++) {
        const r = await call(config, model, system, prompt, maxTokens, fetchImpl)
        if (r.ok) {
          usage.calls += 1
          usage.input += r.input
          usage.output += r.output
          return r.text
        }
        const retry = r.status === 429 || r.status >= 500
        if (!retry || attempt >= 2) throw new Error(`${model}: HTTP ${r.status} ${r.error}`)
        await new Promise(done => setTimeout(done, 2000 * (attempt + 1)))
      }
    } finally {
      release()
    }
  }
}

async function call(config, model, system, prompt, maxTokens, fetchImpl) {
  const base = config.baseUrl.replace(/\/+$/, '')
  let res
  if (config.api === 'anthropic') {
    const auth = config.bearer ? { authorization: `Bearer ${config.apiKey}` } : { 'x-api-key': config.apiKey }
    res = await fetchImpl(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...auth },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
    })
  } else {
    res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    })
  }
  const body = await res.text()
  if (!res.ok) return { ok: false, status: res.status, error: body.slice(0, 300) }
  const data = JSON.parse(body)
  if (config.api === 'anthropic') {
    const text = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
    return { ok: true, text, input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 }
  }
  const text = data.choices?.[0]?.message?.content ?? ''
  return { ok: true, text, input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 }
}

// ---------------------------------------------------------------- caches

function cacheDir(...parts) {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  const dir = join(base, 'session-recap', ...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

const noteFiles = {
  get: key => {
    const path = join(cacheDir('notes'), `${key}.txt`)
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  },
  set: (key, note) => writeFileSync(join(cacheDir('notes'), `${key}.txt`), note),
}

// Characters to tokens: about one token per CJK character, four characters per token otherwise.
export function estimateTokens(text) {
  const cjk = (text.match(/[　-鿿가-힯＀-￯]/g) ?? []).length
  return Math.round(cjk + (text.length - cjk) / 4)
}

function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60_000)
  if (min < 60) return `${Math.max(0, min)}m ago`
  if (min < 48 * 60) return `${Math.round(min / 60)}h ago`
  return `${Math.round(min / 1440)}d ago`
}

// ---------------------------------------------------------------- commands

async function recap(opts) {
  const session = pickSession(opts)
  const cachePath = join(cacheDir('recaps'), `${session.agent}-${session.id.replace(/[^\w.-]/g, '_')}.json`)
  const previous = opts.refresh ? undefined : readJson(cachePath)
  const isFresh = previous !== undefined && previous.size === session.size && previous.mtimeMs === session.mtimeMs
  const from = previous?.prompts !== undefined && !isFresh ? previous.prompts : 0
  const usage = { calls: 0, input: 0, output: 0 }
  let markdown = previous?.markdown

  if (!isFresh) {
    const digest = python(['digest', session.agent, session.path, String(from)])
    if (opts.dryRun) {
      const parts = splitParts(digest.text, CHUNK_CHARS)
      const tokens = estimateTokens(digest.text)
      const report = {
        session: `${LABEL[session.agent]} · ${session.title}`,
        mode: from > 0 ? `update from prompt ${from + 1}` : 'full recap',
        prompts: digest.prompts,
        characters: digest.text.length,
        estimatedInputTokens: tokens,
        modelCalls: parts.length > 1 ? parts.length + 1 : 1,
      }
      process.stdout.write(opts.json ? `${JSON.stringify(report)}\n` : `${Object.entries(report).map(([k, v]) => `${k}: ${v}`).join('\n')}\n`)
      return
    }
    const config = modelConfig(opts)
    if (!config.apiKey || !config.baseUrl) fail('no model configured. Set SESSION_RECAP_API_KEY (and SESSION_RECAP_BASE_URL, SESSION_RECAP_MODEL), or ANTHROPIC_API_KEY, DEEPSEEK_API_KEY or OPENAI_API_KEY. See: session-recap --help', 2)
    if (!config.model) fail('no model name: set SESSION_RECAP_MODEL or pass --model', 2)
    const progress = ({ step, done, total }) => {
      if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${total ? `[${done}/${total}] ` : ''}${step}…`)
    }
    markdown = await writeRecap({
      digest,
      previous: from > 0 ? previous : undefined,
      complete: makeComplete(config, usage),
      notes: noteFiles,
      progress,
    })
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[2K')
    writeFileSync(
      cachePath,
      JSON.stringify({ size: session.size, mtimeMs: session.mtimeMs, at: Date.now(), prompts: digest.prompts, markdown }),
    )
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ session, markdown, cached: isFresh, usage })}\n`)
    return
  }
  const meta = [LABEL[session.agent], session.cwd, `active ${ago(session.mtimeMs)}`, isFresh ? 'cached recap' : 'new recap']
  process.stdout.write(`# ${session.title}\n\n> ${meta.join(' · ')}\n\n${markdown.trim()}\n`)
  if (usage.calls > 0) {
    process.stderr.write(`\n${usage.calls} model call${usage.calls === 1 ? '' : 's'} · ${usage.input} input / ${usage.output} output tokens${from > 0 ? ` · updated from prompt ${from + 1}` : ''}\n`)
  }
}

function list(opts) {
  const agent = opts.agent && opts.agent !== 'auto' ? opts.agent : 'any'
  const query = opts.words.join(' ')
  const rows = python(query ? ['find', query] : ['all']).filter(r => agent === 'any' || r.agent === agent)
  if (opts.json) return process.stdout.write(`${JSON.stringify(rows)}\n`)
  for (const r of rows) {
    process.stdout.write(`${LABEL[r.agent].padEnd(11)} ${ago(r.mtimeMs).padStart(8)}  ${r.title}\n${' '.repeat(22)}${r.cwd}  (${r.id})\n`)
  }
}

function projects(opts) {
  const rows = python(['projects'])
  if (opts.json) return process.stdout.write(`${JSON.stringify(rows)}\n`)
  for (const p of rows) {
    const agents = Object.entries(p.agents).map(([a, n]) => `${LABEL[a]} ${n}`).join(' · ')
    process.stdout.write(`${p.cwd}\n  ${agents} · ${ago(p.mtimeMs)}\n`)
  }
}

// Desktop agents often run tools without the shell profile's PATH, so the
// skill names this install's full command as well.
const FULL_COMMAND = `"${process.execPath}" "${fileURLToPath(import.meta.url)}"`

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

function install(opts) {
  const home = homedir()
  const targets = [
    { agent: 'codex', dir: join(process.env.CODEX_HOME || join(home, '.codex'), 'skills'), when: join(home, '.codex') },
    { agent: 'opencode', dir: join(home, '.config', 'opencode', 'skills'), when: join(home, '.config', 'opencode') },
    // The shared skills folder several agents read (dsh among them where it supports skills).
    { agent: 'any', dir: join(home, '.agents', 'skills'), when: home },
  ]
  const wanted = opts.words.length > 0 ? opts.words : null
  for (const t of targets) {
    const name = t.agent === 'any' ? 'agents' : t.agent
    if (wanted && !wanted.includes(name)) continue
    if (!existsSync(t.when)) {
      process.stdout.write(`skip ${name}: ${t.when} not found\n`)
      continue
    }
    const dir = join(t.dir, 'session-recap')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), skillText(t.agent))
    process.stdout.write(`installed ${join(dir, 'SKILL.md')}\n`)
  }
  process.stdout.write('Claude Code: install the plugin instead: /plugin install session-recap --marketplace BruceXcluding/session-recap\n')
}

function showConfig(opts) {
  const c = modelConfig(opts)
  const lines = [
    `source:     ${c.source ?? '(none)'}`,
    `api:        ${c.api ?? '(none)'}`,
    `base URL:   ${c.baseUrl ?? '(none)'}`,
    `API key:    ${masked(c.apiKey)}`,
    `model:      ${c.model ?? '(none)'}`,
    `part model: ${c.partModel ?? '(none)'}`,
    `config file: ${configPath()}${existsSync(configPath()) ? '' : ' (not present)'}`,
    `agent here: ${detectAgent()}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

export async function main(argv) {
  const opts = parseArgs(argv)
  if (opts.help) return process.stdout.write(`${HELP}\n`)
  if (opts.version) return process.stdout.write(`${VERSION}\n`)
  if (opts.command === 'list') return list(opts)
  if (opts.command === 'projects') return projects(opts)
  if (opts.command === 'install') return install(opts)
  if (opts.command === 'config') return showConfig(opts)
  return recap(opts)
}

// Run as a command (npm links the bin, so compare real paths), not when imported by tests.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(err => fail(err.message))
}
