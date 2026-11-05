// End-to-end runs of the recap pipeline with the world beneath the mod
// simulated: the Python helper, the transcript files and the model.
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

const ROOT = '/home/me/.claude/projects'
const PROJECT = { dir: `${ROOT}/-code-app`, cwd: '/code/app', sessions: 2, mtimeMs: 1000 }
const SESSION = {
  id: 'cur',
  path: `${PROJECT.dir}/cur.jsonl`,
  title: 'Build the app',
  size: 5000,
  mtimeMs: 2000,
}
const OTHER = { ...SESSION, id: 'old', path: `${PROJECT.dir}/old.jsonl`, title: 'Old idea' }
const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

// A transcript as digest.py condenses it: `turns` prompts of ~1 KB each.
function digestOf(turns: number) {
  const text = Array.from(
    { length: turns },
    (_, i) => `[USER 2026-11-0${(i % 9) + 1} 10:00] step ${i} ${'x'.repeat(1000)}\n[CLAUDE] done ${i}`,
  ).join('\n')

  return { title: SESSION.title, cwd: '/code/app', prompts: turns, files: ['/code/app/a.ts'], fileCount: 1, text }
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
    digest?: unknown
    failStage?: 'part' | 'merge'
    store?: Record<string, unknown>
    pythonMissing?: boolean
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
  mock.env(on, { HOME: '/home/me' })
  on('store.get', (_, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'session-recap' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    w.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'cur' }))
  on('session.model', () => ({ value: 'the-session-model' }))
  on('fs.exists', (_, e) => ({ value: e.path === SESSION.path }))
  on('fs.stat', () => ({
    // $.fs.stat may report a fractional mtime where Python's is whole.
    value: { kind: 'file', size: SESSION.size, mtimeMs: SESSION.mtimeMs + 0.6, isLink: false },
  }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    if (options.pythonMissing && argv[0] === 'python3') return { deny: 'ENOENT python3' }
    const mode = argv[3]
    const out =
      mode === 'projects' ? [PROJECT]
      : mode === 'sessions' ? [SESSION, OTHER]
      : (options.digest ?? digestOf(3))
    return {
      value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('model.complete', (_, e) => {
    // Parts are condensed under one system prompt, the recap merged under another.
    const stage = e.system?.startsWith('You condense') ? 'part' : 'merge'
    w.models.push({ model: e.model, stage, prompt: e.prompt })
    if (stage === options.failStage) {
      return { value: { isAnswered: false, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage: USAGE } }
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
  expect(w.runs.some(r => r[3] === 'digest' && r[4] === SESSION.path)).toBe(true)
  expect(w.store.get('recap:cur')).toMatchObject({ size: 5000, mtimeMs: 2000.6 })
  expect(w.toasts).toEqual(['Recap ready: Build the app'])

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Markdown', text: /Build the app\./ })).toBeDefined()
  expect(await ui.find({ key: 'summarize' })).toMatchObject({ text: 'Refresh recap' })
  expect(await ui.find({ type: 'Text', text: /continued since/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^INTENT$/ })).toBeDefined()
  // The tabs narrow what is shown under the intent and resume cards.
  await ui.press({ key: 'tab-changed' })
  expect(await ui.find({ type: 'Text', text: /Nothing in this section/ })).toBeDefined()
  await ui.press({ key: 'tab-all' })
  expect(await ui.find({ type: 'Text', text: /Nothing in this section/ })).toBeDefined()
  await ui.unmount()
})

test('a long session is condensed in parts, then merged, all by the session model', async ($, on) => {
  // ~200 KB of transcript: three parts of at most 75,000 characters.
  const w = world(on, { digest: digestOf(200) })
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
  expect(w.store.get('recap:cur')).toBeDefined()
})

test('a fresh stored recap is shown without calling the model', async ($, on) => {
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

  expect(w.store.get('recap:cur')).toBeUndefined()
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /the-session-model gave no answer/ }))?.text).toContain('api-error 529')
  // The error card offers a retry, which runs the recap again.
  expect(await ui.find({ key: 'retry' })).toBeDefined()
  expect(w.toasts).toEqual([])
  await ui.press({ key: 'retry' })
  expect(w.models.filter(m => m.stage === 'merge').length).toBe(2)
  await ui.unmount()
})

test('browse: pick a project, then a session, then write its recap', async ($, on) => {
  const w = world(on)
  await startSession($)
  await typeCommand($, 'browse')
  await w.clock.settle()

  const ui = await $.ui.mount(PANE)
  await ui.press({ key: PROJECT.dir })
  expect(await ui.find({ key: 'old' })).toBeDefined()
  await ui.press({ key: 'old' })
  expect(await ui.find({ type: 'Text', text: /^Old idea$/ })).toBeDefined()
  expect(w.models).toEqual([])
  await ui.press({ key: 'summarize' })

  expect(w.runs.some(r => r[3] === 'digest' && r[4] === OTHER.path)).toBe(true)
  expect(w.store.get('recap:old')).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /Build the app\./ })).toBeDefined()
  await ui.press({ key: 'to-sessions' })
  expect(await ui.find({ key: 'old', text: /^● / })).toBeDefined()
  await ui.unmount()
})

test('without python3 on PATH it falls back to /usr/bin/python3', async ($, on) => {
  const w = world(on, { pythonMissing: true })
  await startSession($)
  await typeCommand($)
  await w.clock.settle()

  expect(w.runs.some(r => r[0] === '/usr/bin/python3')).toBe(true)
  expect(w.store.get('recap:cur')).toBeDefined()
})

test('/session-recap <project name> opens that project\'s sessions', async ($, on) => {
  const w = world(on)
  await startSession($)
  await typeCommand($, 'App')
  await w.clock.settle()

  expect(w.models).toEqual([])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'cur' })).toBeDefined()
  expect(await ui.find({ key: 'old' })).toBeDefined()
  await ui.unmount()
})

test('/session-recap <session title> writes that session\'s recap', async ($, on) => {
  const w = world(on)
  await startSession($)
  await typeCommand($, 'old idea')
  await w.clock.settle()

  expect(w.runs.some(r => r[3] === 'digest' && r[4] === OTHER.path)).toBe(true)
  expect(w.store.get('recap:old')).toBeDefined()
  expect(w.store.get('recap:cur')).toBeUndefined()
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^Old idea$/ })).toBeDefined()
  await ui.unmount()
})

test('/session-recap <unknown name> says nothing matched', async ($, on) => {
  const w = world(on)
  await startSession($)
  await typeCommand($, 'nowhere')
  await w.clock.settle()

  expect(w.models).toEqual([])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /No project or session matches "nowhere"/ })).toBeDefined()
  expect(await ui.find({ key: PROJECT.dir })).toBeDefined()
  await ui.unmount()
})
