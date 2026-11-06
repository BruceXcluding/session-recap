// Tests for the dsh plugin's tool and command (packages/dsh), with the host's
// defineTool and model call stood in for. Needs `node scripts/build-dsh.mjs`
// first (npm test runs it), which vendors the reader and the recap core.
// Run: node --test tests/dsh.test.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

let home
let recapTool
let recapCommand
let routeOf
let panelRoute
const SESSION = 'session-11111111-2222-3333-4444-555555555555'

const hasZstd = (() => {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

before(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'session-recap-dsh-')))
  process.env.HOME = home
  process.env.XDG_CACHE_HOME = join(home, '.cache')
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.DSH_HOME
  // A Claude Code session, found by its title.
  const folder = join(home, '.claude', 'projects', '-code-web')
  mkdirSync(folder, { recursive: true })
  const line = {
    parentUuid: null,
    type: 'user',
    cwd: '/code/web',
    timestamp: '2026-11-01T10:00:00.000Z',
    message: { role: 'user', content: 'Add a dark theme' },
  }
  writeFileSync(join(folder, 'c1.jsonl'), `${JSON.stringify(line)}\n`)
  // A dsh session, the one "running".
  if (hasZstd) {
    const dir = join(home, '.dsh', 'sessions', '--code-web--', SESSION)
    mkdirSync(dir, { recursive: true })
    const records = [
      { type: 'session', version: 3, id: SESSION, cwd: '/code/web', delegationDepth: 0 },
      {
        type: 'user/message',
        time: 1793000000000,
        data: { content: [{ type: 'text', text: 'Fix the login page' }], source: { kind: 'user' } },
      },
    ]
    writeFileSync(join(dir, 'session.v3.jsonl'), `${records.map(r => JSON.stringify(r)).join('\n')}\n`)
    execFileSync('zstd', ['-q', '--rm', '-o', join(dir, 'session.v3.jsonl.zstd'), join(dir, 'session.v3.jsonl')])
  }
  ;({ recapTool, recapCommand, routeOf, panelRoute } = await import('../packages/dsh/src/recap.js'))
})

after(() => rmSync(home, { recursive: true, force: true }))

// The host's defineTool returns the definition; chatText is the model call.
const calls = []
const deps = {
  defineTool: d => d,
  llm: { name: 'fake-llm' },
  config: {},
  chatText: async (llm, system, user, { route }) => {
    calls.push({ llm, system, user, route })
    return '## Intent\nTheme it.\n\n## Where to resume\nShip.\n\n```json recap-map\n{"phases":[{"title":"Theme"}]}\n```'
  },
}
const agentOn = (id, route = { provider: 'deepseek', model: 'deepseek-v4-flash' }) => ({
  id,
  session: { id, requestHeader: () => ({ config: route }) },
})

test('the tool has the shape dsh registers', () => {
  const tool = recapTool(deps)
  assert.equal(tool.name, 'session_recap')
  assert.deepEqual(Object.keys(tool.parameters), ['session', 'refresh'])
  assert.deepEqual(tool.output.render({}, 'x'), [{ type: 'text', text: 'x' }])
})

test('the route is the session’s own, unless the plugin config names one', () => {
  const session = agentOn('s').session
  assert.deepEqual(routeOf(session, {}), { provider: 'deepseek', model: 'deepseek-v4-flash' })
  assert.deepEqual(routeOf(session, { provider: 'p', model: 'm' }), { provider: 'p', model: 'm' })
  assert.equal(routeOf({}, {}), null)
})

test('a session named by title is recapped with the session’s model, then reused', async () => {
  const tool = recapTool(deps)
  const text = await tool.execute({ session: 'dark theme' }, { agent: agentOn('other') })
  assert.match(
    text,
    /^# Add a dark theme\n\n> Claude Code · \/code\/web · new recap by deepseek-v4-flash\n\n## Intent\nTheme it\./,
  )
  assert.doesNotMatch(text, /recap-map/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].llm.name, 'fake-llm')
  assert.match(calls[0].user, /Add a dark theme/)
  const again = await tool.execute({ session: 'dark theme' }, { agent: agentOn('other') })
  assert.match(again, /stored recap/)
  assert.equal(calls.length, 1)
})

test('/recap reports errors as command errors', async () => {
  const command = recapCommand(deps)
  assert.equal(command.name, 'recap')
  assert.equal(command.input.hint, 'title words or a session id; empty for this session; --refresh to write it again')
  const r = await command.handler({ rawInput: ' nothing matches this', agent: agentOn('x') })
  assert.equal(r.kind, 'error')
  assert.match(r.text, /no session matches/)
})

test(
  'with no session named, the tool recaps the dsh session it runs in',
  { skip: !hasZstd && 'needs zstd' },
  async () => {
    const text = await recapTool(deps).execute({}, { agent: agentOn(SESSION) })
    assert.match(text, /^# Fix the login page\n\n> dsh · \/code\/web · new recap/)
  },
)

test('/recap <words> recaps the named session (rawInput is the text after the name)', async () => {
  const r = await recapCommand(deps).handler({ rawInput: ' dark theme', agent: agentOn('other') })
  assert.equal(r.kind, 'success')
  assert.match(r.text, /^# Add a dark theme\n/)
})

test('an empty model reply is an error, and nothing is cached', async () => {
  const empty = { ...deps, chatText: async () => '' }
  const tool = recapTool(empty)
  await assert.rejects(
    tool.execute({ session: 'dark theme', refresh: true }, { agent: agentOn('other') }),
    /returned no recap text/,
  )
  // The good recap stored earlier is still the one served.
  assert.match(await recapTool(deps).execute({ session: 'dark theme' }, { agent: agentOn('other') }), /Theme it\./)
})

// ------------------------------------------------------------ the side panel

const askPanel = async (request, agent = agentOn('other')) => {
  const r = await recapCommand(deps).handler({ rawInput: ` --panel ${JSON.stringify(request)}`, agent })
  assert.equal(r.kind, 'success')
  return JSON.parse(r.text)
}

test('/recap --panel answers JSON: sessions of a project, with their recaps marked', async () => {
  const before = calls.length
  const answer = await askPanel({ op: 'sessions', cwd: '/code/web' })
  assert.equal(answer.ok, true)
  const row = answer.value.sessions.find(s => s.agent === 'claude')
  assert.equal(row.title, 'Add a dark theme')
  assert.equal(row.recap.fresh, true)
  assert.equal(row.recap.intent, 'Theme it.')
  assert.equal(calls.length, before, 'reading writes nothing')
})

test('/recap --panel get splits the stored recap into Markdown, map and sections', async () => {
  const { value } = await askPanel({ op: 'sessions', cwd: '/code/web' })
  const row = value.sessions.find(s => s.agent === 'claude')
  const got = await askPanel({ op: 'get', agent: 'claude', id: row.id })
  assert.equal(got.ok, true)
  assert.doesNotMatch(got.value.recap.markdown, /recap-map/)
  assert.deepEqual(got.value.recap.map.phases.map(p => p.title), ['Theme'])
  assert.equal(got.value.recap.sections.resume, 'Ship.')
  assert.equal(got.value.recap.model, 'deepseek-v4-flash')
})

test('/recap --panel write rewrites on request; errors come back as ok: false', async () => {
  const { value } = await askPanel({ op: 'sessions', cwd: '/code/web' })
  const row = value.sessions.find(s => s.agent === 'claude')
  const before = calls.length
  const written = await askPanel({ op: 'write', agent: 'claude', id: row.id, refresh: true })
  assert.equal(written.ok, true)
  assert.equal(calls.length, before + 1)
  assert.equal(written.value.recap.sections.intent, 'Theme it.')
  assert.deepEqual(await askPanel({ op: 'nope' }), { ok: false, error: 'unknown panel request "nope"' })
  assert.match((await askPanel({ op: 'get', agent: 'claude', id: 'missing' })).error, /no claude session missing/)
  const bad = await recapCommand(deps).handler({ rawInput: '--panel {oops', agent: agentOn('x') })
  assert.equal(JSON.parse(bad.text).ok, false)
})

test(
  '/recap --panel home: the running session, its project and whether a recap can be written',
  { skip: !hasZstd && 'needs zstd' },
  async () => {
    const { ok, value } = await askPanel({ op: 'home' }, agentOn(SESSION))
    assert.equal(ok, true)
    assert.equal(value.current.session.id, SESSION)
    assert.equal(value.cwd, '/code/web')
    assert.deepEqual(value.sessions.map(s => s.agent).sort(), ['claude', 'dsh'])
    assert.equal(value.canWrite, true)
  },
)

// The browser half, with the host's module loader and React stood in for:
// a render is one synchronous call, hooks give their first values.
test('the web client registers its right-sidebar tab and renders without a session', async () => {
  const { readFileSync } = await import('node:fs')
  const tree = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
  const React = {
    createElement: tree,
    useState: v => [v, () => {}],
    useEffect: () => {},
    useCallback: f => f,
    useRef: v => ({ current: v }),
  }
  let loaded
  globalThis.window = { __ModuleLoader__: { load: m => (loaded = m) } }
  try {
    new Function(readFileSync(new URL('../packages/dsh/client/client.js', import.meta.url), 'utf8'))()
  } finally {
    delete globalThis.window
  }
  assert.equal(loaded.id, 'dsh-session-recap')
  const mod = loaded.factory(name => {
    assert.equal(name, 'react')
    return React
  })
  assert.deepEqual(mod.inject, ['slots', 'sidebarRightTabs'])
  const registered = { tabs: [], slots: {} }
  mod.apply({
    effect: f => f(),
    sidebarRightTabs: { register: t => registered.tabs.push(t) },
    slots: { inject: (_name, f) => f(), register: (key, c) => (registered.slots[key.name] = c) },
  })
  assert.equal(registered.tabs[0].kind, 'session-recap')
  assert.equal(registered.tabs[0].priority, 'extension')
  const Body = registered.slots['sidebar.right.pane.tab']
  const text = node => {
    if (typeof node === 'string') return node
    if (typeof node?.type === 'function') return text(node.type({ ...node.props, children: node.children }))
    return node?.children ? node.children.map(text).join('') : ''
  }
  assert.match(text(Body({})), /Open a session to see its recap/)
  assert.match(text(Body({ sessionId: 's1' })), /Reading sessions/)
  assert.equal(registered.slots['sidebar.right.pane.tab.title']({}), 'Session recap')
})

test('the panel route reads without the chat, and refuses writes', async () => {
  const route = panelRoute(deps)
  assert.equal(route.path, '/api/session-recap/panel')
  assert.deepEqual(route.methods, ['POST'])
  const post = body => route.fetch(new Request('http://dsh/api/session-recap/panel', { method: 'POST', body: JSON.stringify(body) }))
  const res = await post({ op: 'sessions', cwd: '/code/web' })
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const answer = await res.json()
  assert.equal(answer.ok, true)
  assert.ok(answer.value.sessions.some(s => s.title === 'Add a dark theme'))
  assert.deepEqual(await (await post({ op: 'write', agent: 'claude', id: 'x' })).json(), {
    ok: false,
    error: 'write a recap with /recap in the session',
  })
})

test('/recap --refresh <words> writes the named recap again', async () => {
  const before = calls.length
  const r = await recapCommand(deps).handler({ rawInput: '--refresh dark theme', agent: agentOn('other') })
  assert.equal(r.kind, 'success')
  assert.match(r.text, /new recap by/)
  assert.equal(calls.length, before + 1)
})
