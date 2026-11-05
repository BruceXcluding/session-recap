import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-recap',
  component: 'Pane',
  requestId: 'session-recap',
  props: {
    title: 'Session recap',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SESSION = {
  agent: 'claude',
  id: 's1',
  path: '/p/s1.jsonl',
  cwd: '/home/me/code/web-shop',
  title: '结账页面重构',
  size: 2000,
  mtimeMs: 1000,
  recap: 'fresh',
}
const PROJECT = { cwd: '/home/me/code/web-shop', sessions: 3, mtimeMs: 1000, agents: { claude: 2, codex: 1 } }

function seed(value: unknown) {
  return (_: unknown, e: { key: string }) =>
    e.key === 'view'
      ? { value: { value: { shape: 'view-3', value }, version: 1 } }
      : { value: { value: { shape: 'jobs-3', value: { 'claude:s1': { step: 'Condensed 2 of 7 parts', done: 2, total: 8 } } }, version: 1 } }
}

test('the recap screen draws the recap and the progress, on every surface', async ($, on) => {
  on('state.get', seed({
    screen: 'recap',
    projects: [PROJECT],
    project: PROJECT,
    sessions: [SESSION],
    session: SESSION,
    recap: { size: 2000, mtimeMs: 1000, at: 0, markdown: '## Intent\nShip the app.\n\n## Key ideas and decisions\n- Use PWA\n\n## Where to resume\nWrite tests.' },
  }))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /结账页面/ }))?.text).toBe('结账页面重构')
    expect((await ui.find({ type: 'Text', text: /Condensed 2 of 7/ }))?.text).toBe('▰▰▰▱▱▱▱▱▱▱▱▱  Condensed 2 of 7 parts…')
    expect(await ui.find({ type: 'Text', text: /^INTENT$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^WHERE TO RESUME$/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Use PWA/ })).toBeDefined()
    expect(await ui.find({ key: 'copy' })).toBeDefined()
    // A recap is being written, so no second one can be started.
    expect(await ui.find({ key: 'summarize' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the sessions screen lists each session by title', async ($, on) => {
  on('state.get', seed({
    screen: 'sessions',
    projects: [PROJECT],
    project: PROJECT,
    sessions: [SESSION, { ...SESSION, agent: 'codex', id: 's2', title: 'rc', recap: undefined }],
  }))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'claude:s1' })).toBeDefined()
    expect((await ui.find({ key: 'codex:s2' }))?.text).toContain('Codex')
    // Sessions from more than one agent get a filter.
    expect(await ui.find({ key: 'agent-codex' })).toBeDefined()
    expect(await ui.find({ key: 'to-projects' })).toBeDefined()
    await ui.unmount()
  }
})

test('a view an earlier version stored is declined', async ($, on) => {
  on('state.get', () => ({ value: { value: { screen: 'recap' }, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Loading/ }))?.text).toBe('Loading projects…')
  await ui.unmount()
})
