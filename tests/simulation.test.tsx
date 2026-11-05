// End-to-end runs of the recap pipeline with the world beneath the plugin
// simulated: the Python helper, the saved sessions and the model.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'session-recap',
  component: 'Pane',
  requestId: 'session-recap',
  surface: 'desktop',
  props: {
    title: 'Session recap',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const PROJECT = { cwd: '/code/app', sessions: 2, mtimeMs: 1000, agents: { claude: 1, codex: 1 } }
const SESSION = {
  agent: 'claude',
  id: 'cur',
  path: '/home/me/.claude/projects/-code-app/cur.jsonl',
  cwd: '/code/app',
  title: 'Build the app',
  size: 5000,
  mtimeMs: 2000,
}
const OTHER = {
  ...SESSION,
  agent: 'codex',
  id: 'old',
  path: '/home/me/.codex/sessions/rollout-old.jsonl',
  title: 'Old idea',
}
const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

// A session as digest.py condenses it: `turns` prompts of ~1 KB each,
// starting after the first `from` prompts.
function digestOf(turns: number, from = 0) {
  const text = Array.from(
    { length: turns - from },
    (_, i) => `[USER 2026-11-0${(i % 9) + 1} 10:00] step ${i + from} ${'x'.repeat(1000)}\n[ASSISTANT] done ${i + from}`,
  ).join('\n')

  return {
    agent: 'claude',
    title: SESSION.title,
    cwd: '/code/app',
    prompts: turns,
    from,
    files: ['/code/app/a.ts'],
    fileCount: 1,
    text,
  }
}

// digest.py's `context`: the session matching the query (id, else title) and its project.
function context(query: string) {
  const q = query.toLowerCase()
  const hit =
    [SESSION, OTHER].find(s => s.id === q) ?? [SESSION, OTHER].find(s => s.title.toLowerCase().includes(q)) ?? null
  return { projects: [PROJECT], session: hit, sessions: hit ? [SESSION, OTHER] : [] }
}

type World = {
  models: { model: string; stage: 'part' | 'merge'; prompt: string }[]
  runs: string[][]
  toasts: string[]
  clock: ReturnType<typeof mock.clock>
  store: Map<string, unknown>
}

function world(
  on: On,
  options: {
    turns?: number
    failStage?: 'part' | 'merge'
    store?: Record<string, unknown>
    pythonMissing?: boolean
    projects?: unknown[]
    modelDelayMs?: number
  } = {},
): World {
  const w: World = {
    models: [],
    runs: [],
    toasts: [],
    clock: mock.clock(on),
    store: new Map(Object.entries(options.store ?? {})),
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('command.register', () => ({ value: { command: 'session-recap' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    w.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'cur' }))
  on('session.root', () => ({ value: '/code/app' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('session.model', () => ({ value: 'the-session-model' }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    if (options.pythonMissing && argv[0] === 'python3') return { deny: 'ENOENT python3' }
    const [mode, a, , from] = argv.slice(3)
    const out =
      mode === 'projects'
        ? (options.projects ?? [PROJECT])
        : mode === 'sessions'
          ? [SESSION, OTHER]
          : mode === 'context'
            ? context(String(a))
            : digestOf(options.turns ?? 3, Number(from ?? 0))
    return {
      value: {
        exitCode: 0,
        stdout: JSON.stringify(out),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('model.complete', async (_, e) => {
    // A slow model answers on the test's clock, so a test can watch the work run.
    if (options.modelDelayMs !== undefined) await w.clock.sleep(options.modelDelayMs)
    // Parts are condensed under one system prompt, the recap merged under another.
    const stage = e.system?.startsWith('You condense') ? 'part' : 'merge'
    w.models.push({ model: e.model, stage, prompt: e.prompt })
    if (stage === options.failStage) {
      return {
        value: {
          isAnswered: false,
          reason: 'api-error' as const,
          status: 529,
          error: 'overloaded' as const,
          usage: USAGE,
        },
      }
    }
    const text =
      stage === 'part'
        ? `- note on ${/part (\d+) of/.exec(e.prompt)?.[1] ?? '?'}`
        : '## Intent\nBuild the app.\n\n## Where to resume\nWrite tests.'
    return { value: { isAnswered: true, text, usage: USAGE } }
  })

  return w
}

async function startSession($: Engine) {
  await $.session.start({ cwd: '/code/app', surface: 'desktop', isInteractive: true })
}

// The person typing /session-recap [args] at the desktop prompt.
async function typeCommand($: Engine, args = '') {
  await $.command.run({
    command: 'session-recap',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
}

test('/session-recap on a short session: one call to the session model, the recap stored and drawn', async ($, on) => {
  const w = world(on)
  await startSession($)
  await typeCommand($)
  await w.clock.settle()

  expect(w.models.map(m => [m.stage, m.model])).toEqual([['merge', 'the-session-model']])
  expect(w.models[0]?.prompt).toContain('Session title: Build the app')
  expect(w.models[0]?.prompt).toContain('/code/app/a.ts')
  expect(w.runs.some(r => r[3] === 'digest' && r[4] === 'claude' && r[5] === SESSION.path && r[6] === '0')).toBe(true)
  expect(w.store.get('recap:claude:cur')).toMatchObject({ size: 5000, mtimeMs: 2000, prompts: 3 })
  expect(w.toasts).toEqual(['Recap ready: Build the app'])

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Markdown', text: /Build the app\./ })).toBeDefined()
  expect(await ui.find({ key: 'summarize' })).toMatchObject({ text: 'Refresh recap' })
  expect(await ui.find({ type: 'Text', text: /continued since/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^INTENT$/ })).toBeDefined()
  // The tabs narrow what is shown under the intent and resume cards.
  await ui.press({ key: 'tab-changed' })
  expect(await ui.find({ type: 'Text', text: /Nothing in this section/ })).toBeDefined()
  await ui.unmount()
})

test('a long session is condensed in parts, then merged, all by the session model', async ($, on) => {
  // ~200 KB of transcript: three parts of at most 75,000 characters.
  const w = world(on, { turns: 200 })
  await startSession($)
  await typeCommand($)
  await w.clock.settle()

  const parts = w.models.filter(m => m.stage === 'part')
  expect(parts.length).toBe(3)
  expect(w.models.every(m => m.model === 'the-session-model')).toBe(true)
  // Each part starts at a prompt, so no turn is split.
  for (const call of parts) expect(call.prompt).toMatch(/<transcript-part>\n\n?\[USER /)
  const merge = w.models.at(-1)
  expect(merge?.stage).toBe('merge')
  for (const n of [1, 2, 3]) expect(merge?.prompt).toContain(`- note on ${n}`)
})

test('part notes are cached: writing the recap again condenses nothing again', async ($, on) => {
  const w = world(on, { turns: 200 })
  await startSession($)
  await typeCommand($)
  await w.clock.settle()
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'summarize' })

  expect(w.models.filter(m => m.stage === 'part').length).toBe(3)
  expect(w.models.filter(m => m.stage === 'merge').length).toBe(2)
  expect([...w.store.keys()].filter(k => k.startsWith('note:')).length).toBe(3)
  await ui.unmount()
})

test(
  'a cheaper part model can be set; the merge stays on the session model',
  { options: { partModel: 'haiku' } },
  async ($, on) => {
    const w = world(on, { turns: 200 })
    await startSession($)
    await typeCommand($)
    await w.clock.settle()

    expect(new Set(w.models.filter(m => m.stage === 'part').map(m => m.model))).toEqual(new Set(['haiku']))
    expect(w.models.at(-1)?.model).toBe('the-session-model')
  },
)

test('a session that went on is updated from the prompts after the old recap', async ($, on) => {
  const old = { size: 4000, mtimeMs: 1500, at: 0, prompts: 2, markdown: '## Intent\nStart the app.' }
  const w = world(on, { turns: 3, store: { 'recap:claude:cur': old } })
  await startSession($)
  await typeCommand($)
  await w.clock.settle()

  expect(w.runs.some(r => r[3] === 'digest' && r[6] === '2')).toBe(true)
  const merge = w.models.at(-1)
  expect(merge?.prompt).toContain('<previous-recap>\n## Intent\nStart the app.')
  expect(merge?.prompt).toContain('prompts 2 to 3')
  expect(merge?.prompt).not.toContain('step 0')
  expect(w.store.get('recap:claude:cur')).toMatchObject({ prompts: 3, size: 5000 })
})

test('the store keeps the newest 250 recaps and 100 notes', async ($, on) => {
  const store: Record<string, unknown> = { notes: ['n0'] }
  for (let i = 0; i < 260; i++) store[`recap:codex:r${i}`] = { size: 1, mtimeMs: 1, at: i, markdown: 'x' }
  for (let i = 0; i < 105; i++) store[`note:n${i}`] = { note: 'x', at: i }
  const w = world(on, { store })
  await startSession($)
  await typeCommand($)
  await w.clock.settle()

  const keys = [...w.store.keys()]
  expect(keys.filter(k => k.startsWith('recap:')).length).toBe(250)
  expect(keys.filter(k => k.startsWith('note:')).length).toBe(100)
  // The new recap is the newest, so it stays; the oldest go.
  expect(w.store.has('recap:claude:cur')).toBe(true)
  expect(w.store.has('recap:codex:r0')).toBe(false)
  expect(w.store.has('notes')).toBe(false)
})

test('a recap stored by version 0.2 (keyed by id alone) is still found', async ($, on) => {
  const recap = { size: 5000, mtimeMs: 2000, at: 0, markdown: '## Intent\nCached.' }
  const w = world(on, { store: { 'recap:cur': recap } })
  await startSession($)
  await typeCommand($)
  await w.clock.settle()

  expect(w.models).toEqual([])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Markdown', text: /Cached/ })).toBeDefined()
  await ui.unmount()
})

test('a model failure is shown in the pane and the recap can be retried', async ($, on) => {
  const w = world(on, { failStage: 'merge' })
  await startSession($)
  await typeCommand($)
  await w.clock.settle()

  expect(w.store.get('recap:claude:cur')).toBeUndefined()
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /the-session-model gave no answer/ }))?.text).toContain('api-error 529')
  expect(await ui.find({ key: 'retry' })).toBeDefined()
  expect(w.toasts).toEqual([])
  await ui.press({ key: 'retry' })
  expect(w.models.filter(m => m.stage === 'merge').length).toBe(2)
  await ui.unmount()
})

test('browse: pick a project, filter by agent, pick a Codex session, write its recap', async ($, on) => {
  const w = world(on)
  await startSession($)
  await typeCommand($, 'browse')
  await w.clock.settle()

  const ui = await $.ui.mount(PANE)
  // This session's folder is the project pinned on top; other agents' sessions are named beside it.
  expect(await ui.find({ type: 'Text', text: /^THIS PROJECT$/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /also Codex 1/ }))?.text).toContain('/code/app')
  await ui.press({ key: PROJECT.cwd })
  // In this IDE's scope the list opens on its own sessions.
  expect(await ui.find({ key: 'codex:old' })).toBeUndefined()
  expect(await ui.find({ key: 'claude:cur' })).toBeDefined()
  await ui.press({ key: 'agent-codex' })
  expect(await ui.find({ key: 'claude:cur' })).toBeUndefined()
  await ui.press({ key: 'codex:old' })
  expect(await ui.find({ type: 'Text', text: /^Old idea$/ })).toBeDefined()
  expect(w.models).toEqual([])
  await ui.press({ key: 'summarize' })

  expect(w.runs.some(r => r[3] === 'digest' && r[4] === 'codex' && r[5] === OTHER.path)).toBe(true)
  expect(w.store.get('recap:codex:old')).toBeDefined()
  await ui.press({ key: 'to-sessions' })
  await ui.press({ key: 'agent-all' })
  expect(await ui.find({ key: 'codex:old', text: /^● / })).toBeDefined()
  await ui.unmount()
})

test('without python3 on PATH it falls back to /usr/bin/python3', async ($, on) => {
  const w = world(on, { pythonMissing: true })
  await startSession($)
  await typeCommand($)
  await w.clock.settle()

  expect(w.runs.some(r => r[0] === '/usr/bin/python3')).toBe(true)
  expect(w.store.get('recap:claude:cur')).toBeDefined()
})

test("/session-recap <project name> opens that project's sessions", async ($, on) => {
  const w = world(on)
  await startSession($)
  await typeCommand($, 'App')
  await w.clock.settle()

  expect(w.models).toEqual([])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'claude:cur' })).toBeDefined()
  expect(await ui.find({ key: 'codex:old' })).toBeDefined()
  await ui.unmount()
})

test("/session-recap <session title> writes that session's recap", async ($, on) => {
  const w = world(on)
  await startSession($)
  await typeCommand($, 'old idea')
  await w.clock.settle()

  expect(w.runs.some(r => r[3] === 'digest' && r[5] === OTHER.path)).toBe(true)
  expect(w.store.get('recap:codex:old')).toBeDefined()
  expect(w.store.get('recap:claude:cur')).toBeUndefined()
})

test('/session-recap <unknown name> says nothing matched', async ($, on) => {
  const w = world(on)
  await startSession($)
  await typeCommand($, 'nowhere')
  await w.clock.settle()

  expect(w.models).toEqual([])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /No project or session matches "nowhere"/ })).toBeDefined()
  expect(await ui.find({ key: PROJECT.cwd })).toBeDefined()
  await ui.unmount()
})

const MORE = [
  PROJECT,
  { cwd: '/home/me/code/api', sessions: 2, mtimeMs: Date.now() - 2 * 86_400_000, agents: { claude: 2 } },
  { cwd: '/home/me/code/codex-only', sessions: 4, mtimeMs: Date.now(), agents: { codex: 4 } },
  {
    cwd: '/home/me/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-1',
    sessions: 1,
    mtimeMs: Date.now(),
    agents: { claude: 1 },
  },
]

test('Projects: this IDE by default, grouped by time, temporary folders folded, all agents on request', async ($, on) => {
  const w = world(on, { projects: MORE })
  await startSession($)
  await typeCommand($, 'browse')
  await w.clock.settle()

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: '/home/me/code/api' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^THIS WEEK$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /~\/code\/api/ })).toBeDefined()
  // A project with no Claude Code session waits behind the scope switch.
  expect(await ui.find({ key: '/home/me/code/codex-only' })).toBeUndefined()
  expect((await ui.find({ key: 'show-all' }))?.text).toContain('1 more project')
  // Scratch folders are folded until asked for.
  expect(await ui.find({ key: 'temp' })).toMatchObject({ text: '▸ Temporary folders (1)' })
  expect(await ui.find({ key: MORE[3]!.cwd })).toBeUndefined()
  await ui.press({ key: 'temp' })
  expect(await ui.find({ key: MORE[3]!.cwd })).toBeDefined()

  await ui.press({ key: 'scope-all' })
  expect(await ui.find({ key: '/home/me/code/codex-only' })).toBeDefined()
  expect(await ui.find({ key: 'show-all' })).toBeUndefined()
  // The choice is kept for the next session.
  expect(w.store.get('prefs')).toMatchObject({ scope: 'all' })
  await ui.unmount()
})

test('the scope chosen in an earlier session is the one a new session opens with', async ($, on) => {
  const w = world(on, { projects: MORE, store: { prefs: { model: '', partModel: '', scope: 'all' } } })
  await startSession($)
  await typeCommand($, 'browse')
  await w.clock.settle()

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: '/home/me/code/codex-only' })).toBeDefined()
  await ui.unmount()
})

test('a model picked in the pane writes the recap, is kept, and is named on the recap', async ($, on) => {
  const w = world(on, { turns: 200 })
  await startSession($)
  await typeCommand($, 'browse')
  await w.clock.settle()

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'settings' })
  expect((await ui.find({ key: 'model-session' }))?.text).toBe('Session model · the-session-model')
  await ui.press({ key: 'model-sonnet' })
  await ui.press({ key: 'part-haiku' })
  expect(await ui.find({ key: 'settings' })).toMatchObject({ text: 'Model: sonnet' })
  expect(w.store.get('prefs')).toMatchObject({ model: 'sonnet', partModel: 'haiku' })

  await ui.press({ key: PROJECT.cwd })
  await ui.press({ key: 'claude:cur' })
  await ui.press({ key: 'summarize' })
  expect(new Set(w.models.filter(m => m.stage === 'part').map(m => m.model))).toEqual(new Set(['haiku']))
  expect(w.models.at(-1)?.model).toBe('sonnet')
  expect(w.store.get('recap:claude:cur')).toMatchObject({ model: 'sonnet' })
  expect(await ui.find({ type: 'Text', text: /by sonnet/ })).toBeDefined()

  // Back to the session's own model.
  await ui.press({ key: 'model-session' })
  expect(w.store.get('prefs')).toMatchObject({ model: '' })
  await ui.unmount()
})

test(
  'a recap model set in the plugin settings is the default choice',
  { options: { model: 'opus' } },
  async ($, on) => {
    const w = world(on)
    await startSession($)
    await typeCommand($)
    await w.clock.settle()

    expect(w.models.at(-1)?.model).toBe('opus')
  },
)

test('the progress animates while a recap is written, and stops when it is done', async ($, on) => {
  const w = world(on, { modelDelayMs: 3000 })
  await startSession($)
  await typeCommand($)
  await w.clock.settle()

  const ui = await $.ui.mount(PANE)
  const line = async () => (await ui.find({ type: 'Text', text: /Writing the recap with/ }))?.text
  const first = await line()
  expect(first).toMatch(/^⠋ /)
  await w.clock.advance(400)
  const second = await line()
  // Two frames later: another spinner glyph, and the clock has moved.
  expect(second).toMatch(/^⠹ /)
  expect(second).not.toBe(first)
  await w.clock.advance(1600)
  expect(await line()).toMatch(/· 2s$/)

  await w.clock.advance(1500)
  expect(await ui.find({ type: 'Text', text: /^Writing the recap$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Markdown', text: /Build the app\./ })).toBeDefined()
  await ui.unmount()
})
