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

// A recap 65 s in, at frame 3 of the animation.
const JOBS = { 'claude:s1': { step: 'Condensed 2 of 7 parts', done: 2, total: 8, startedAt: 10_000 } }
const TICK = { frame: 3, now: 75_000 }

function seed(value: unknown) {
  return (_: unknown, e: { key: string }) => ({
    value: {
      value:
        e.key === 'view'
          ? { shape: 'view-4', value }
          : e.key === 'tick'
            ? { shape: 'tick-1', value: TICK }
            : { shape: 'jobs-4', value: JOBS },
      version: 1,
    },
  })
}

test('the recap screen draws the recap and the progress, on every surface', async ($, on) => {
  on(
    'state.get',
    seed({
      screen: 'recap',
      projects: [PROJECT],
      project: PROJECT,
      sessions: [SESSION],
      session: SESSION,
      recap: {
        size: 2000,
        mtimeMs: 1000,
        at: 0,
        markdown:
          '## Intent\nShip the app.\n\n## Key ideas and decisions\n- Use PWA\n\n## Where to resume\nWrite tests.',
      },
    }),
  )

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /结账页面/ }))?.text).toBe('结账页面重构')
    expect((await ui.find({ type: 'Text', text: /Condensed 2 of 7/ }))?.text).toBe(
      // Frame 3: the spinner's 4th glyph, 3 of 12 cells done, the sweep at cells 6–7, 65 s so far.
      '⠸ ▰▰▰▱▱▰▰▱▱▱▱▱  Condensed 2 of 7 parts… · 1m 05s',
    )
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
  on(
    'state.get',
    seed({
      screen: 'sessions',
      projects: [PROJECT],
      project: PROJECT,
      sessions: [SESSION, { ...SESSION, agent: 'codex', id: 's2', title: 'rc', recap: undefined }],
    }),
  )

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

const MAP = (dates: [string, string?][]) =>
  JSON.stringify({
    phases: dates.map(([from, to], i) => ({
      title: `Phase ${i + 1}`,
      from,
      to,
      summary: `step ${i + 1}`,
      pivot: i === 1,
    })),
    decisions: [
      { chosen: 'Keep going', rejected: [], status: 'done' },
      { chosen: 'Test demand first', rejected: ['Ads'], why: 'cheapest signal', status: 'open' },
    ],
    shipped: ['A'],
    open: ['B'],
    rejected: [],
  })

function mapView(map: string, mtimeMs: number) {
  const session = { ...SESSION, mtimeMs }
  return seed({
    screen: 'recap',
    mode: 'map',
    projects: [PROJECT],
    project: PROJECT,
    sessions: [session],
    session,
    recap: { size: 2000, mtimeMs, at: 0, markdown: `## Intent\nX\n\n\`\`\`json recap-map\n${map}\n\`\`\`` },
  })
}

test('the map shows dates the session can have, in order, and the open decisions first', async ($, on) => {
  on('state.get', (_, e) =>
    e.key === 'jobs'
      ? { value: { value: { shape: 'jobs-4', value: {} }, version: 1 } }
      : mapView(MAP([['2026-10-13', '2026-10-20'], ['2026-10-29']]), Date.parse('2026-11-02'))(_, e),
  )

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^10-13 → 10-20$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^2 phases · 10-13 → 10-29$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^DECISIONS · 2$/ })).toBeDefined()
    const [first] = await ui.findAll({ type: 'Text', text: /^(Keep going|Test demand first)$/ })
    expect(first?.text).toBe('Test demand first')
    await ui.unmount()
  }
})

test('dates after the session last ran, or out of order, are not shown', async ($, on) => {
  on('state.get', (_, e) =>
    e.key === 'jobs'
      ? { value: { value: { shape: 'jobs-4', value: {} }, version: 1 } }
      : mapView(MAP([['2026-10-13'], ['2026-11-12']]), Date.parse('2026-11-02'))(_, e),
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /11-12|10-13/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^2 phases$/ })).toBeDefined()
  await ui.unmount()
})
