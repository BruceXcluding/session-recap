// Tests for the MCP server and the local viewer: each runs as its own process
// against a temporary home holding one Claude Code session.
// Run: node --test tests/mcp.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'session-recap.mjs')

let home
let project
let env

before(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'session-recap-mcp-')))
  project = join(home, 'code', 'shop')
  mkdirSync(project, { recursive: true })
  const folder = join(home, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(folder, { recursive: true })
  const token = 'gh' + 'p_' + 'Q'.repeat(36)
  const lines = [
    ['2026-11-01T10:00:00.000Z', 'Build the checkout page'],
    ['2026-11-01T11:00:00.000Z', `Deploy it, the token is ${token}`],
  ].map(([timestamp, content]) =>
    JSON.stringify({ parentUuid: null, type: 'user', cwd: project, timestamp, message: { role: 'user', content } }),
  )
  writeFileSync(join(folder, 's1.jsonl'), `${lines.join('\n')}\n`)
  // No model key of any provider: the agent writes recaps itself.
  env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_CONFIG_HOME: join(home, '.config'),
  }
})

after(() => rmSync(home, { recursive: true, force: true }))

describe('the MCP server', () => {
  let child
  let replies
  let nextId = 1

  before(() => {
    child = spawn(process.execPath, [CLI, 'mcp'], { cwd: project, env })
    const lines = createInterface({ input: child.stdout })
    replies = new Map()
    lines.on('line', line => {
      const msg = JSON.parse(line)
      replies.get(msg.id)?.(msg)
    })
  })

  after(() => child.kill())

  const call = (method, params) =>
    new Promise(done => {
      const id = nextId++
      replies.set(id, done)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const tool = async (name, args) => (await call('tools/call', { name, arguments: args })).result

  test('initializes and lists its three tools', async () => {
    const init = await call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '0' },
    })
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.equal(init.result.serverInfo.name, 'session-recap')
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const list = await call('tools/list', {})
    assert.deepEqual(
      list.result.tools.map(t => t.name),
      ['list_sessions', 'recap_session', 'save_recap'],
    )
  })

  test('list_sessions finds the session', async () => {
    const r = await tool('list_sessions', { cwd: project })
    assert.equal(r.structuredContent.sessions.length, 1)
    assert.match(r.content[0].text, /Claude Code · Build the checkout page/)
  })

  test('with no model, recap_session hands the transcript to the agent, without the secret', async () => {
    const r = await tool('recap_session', { cwd: project, agent: 'claude' })
    assert.equal(r.structuredContent.mode, 'agent')
    assert.equal(r.structuredContent.prompts, 2)
    assert.equal(r.structuredContent.redactions, 1)
    assert.match(r.content[0].text, /call save_recap with agent "claude", id "s1", prompts 2/)
    assert.match(r.structuredContent.prompt, /\[REDACTED:github-token\]/)
    assert.doesNotMatch(JSON.stringify(r), /ghp_Q/)
    assert.match(r.structuredContent.prompt, /## Intent/)
  })

  test('save_recap stores it; the next recap_session returns it with its map', async () => {
    const markdown =
      '## Intent\nShip checkout.\n\n## Where to resume\nDeploy.\n\n```json recap-map\n{"phases":[{"title":"Build"}],"open":["Deploy"]}\n```'
    const saved = await tool('save_recap', { agent: 'claude', id: 's1', prompts: 2, markdown })
    assert.equal(saved.structuredContent.saved, true)
    const r = await tool('recap_session', { cwd: project, agent: 'claude' })
    assert.equal(r.structuredContent.mode, 'recap')
    assert.equal(r.structuredContent.markdown, '## Intent\nShip checkout.\n\n## Where to resume\nDeploy.')
    assert.equal(r.structuredContent.map.phases[0].title, 'Build')
    assert.match(r.content[0].text, /stored recap/)
  })

  test('another format is written by the agent, not stored, and does not replace the recap', async () => {
    const r = await tool('recap_session', { cwd: project, agent: 'claude', format: 'standup' })
    assert.equal(r.structuredContent.mode, 'agent')
    assert.equal(r.structuredContent.format, 'standup')
    assert.match(r.structuredContent.prompt, /## Done\n/)
    assert.doesNotMatch(r.structuredContent.prompt, /recap-map/)
    assert.match(r.content[0].text, /Write this standup yourself and show it to the person \(it is not stored\)/)
    const stored = await tool('recap_session', { cwd: project, agent: 'claude' })
    assert.equal(stored.structuredContent.mode, 'recap')
    const bad = await tool('recap_session', { cwd: project, agent: 'claude', format: 'poem' })
    assert.equal(bad.isError, true)
    assert.match(bad.content[0].text, /no recap format "poem"/)
  })

  test('errors come back as tool errors, unknown methods as JSON-RPC errors', async () => {
    const r = await tool('recap_session', { session: 'no such words anywhere' })
    assert.equal(r.isError, true)
    assert.match(r.content[0].text, /no session matches/)
    const bad = await tool('save_recap', { agent: 'claude', id: 'nope', prompts: 1, markdown: 'x' })
    assert.equal(bad.isError, true)
    const unknown = await call('resources/list', {})
    assert.equal(unknown.error.code, -32601)
  })
})

describe('mcp-config', () => {
  const run = (...args) =>
    new Promise(done => {
      const child = spawn(process.execPath, [CLI, ...args], { env })
      let out = ''
      child.stdout.on('data', c => (out += c))
      child.on('close', code => done({ code, out }))
    })

  test('prints an entry with absolute paths for each client', async () => {
    const codex = await run('mcp-config', 'codex')
    assert.match(
      codex.out,
      /^\[mcp_servers\.session-recap\]\ncommand = ".+node.*"\nargs = \[".+session-recap\.mjs","mcp"\]\n$/,
    )
    const cursor = JSON.parse((await run('mcp-config', 'cursor')).out)
    assert.deepEqual(cursor.mcpServers['session-recap'].args.at(-1), 'mcp')
    const all = await run('mcp-config')
    for (const name of ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'zed', 'vscode', 'cline']) {
      assert.match(all.out, new RegExp(`## ${name} · `))
    }
    assert.equal((await run('mcp-config', 'emacs')).code, 1)
  })
})

describe('the local viewer', () => {
  let child
  let base
  let token

  before(async () => {
    child = spawn(process.execPath, [CLI, 'serve', '--port', '0', '--no-open'], { env })
    const first = await new Promise(done => child.stdout.once('data', c => done(String(c))))
    const url = new URL(/http:\/\/\S+/.exec(first)[0])
    base = url.origin
    token = url.searchParams.get('t')
  })

  after(() => child.kill())

  const get = (path, headers = {}) => fetch(`${base}${path}`, { headers })

  test('the page needs the token; it then sets the cookie', async () => {
    assert.equal((await get('/')).status, 401)
    const page = await get(`/?t=${token}`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('set-cookie'), /^sr_token=.+; HttpOnly; SameSite=Strict/)
    assert.match(await page.text(), /<title>session-recap<\/title>/)
  })

  test('the API needs the cookie and a loopback host', async () => {
    const cookie = `sr_token=${token}`
    assert.equal((await get('/api/projects')).status, 401)
    assert.equal((await get('/api/projects', { cookie: 'sr_token=wrong' })).status, 401)
    const projects = await (await get('/api/projects', { cookie })).json()
    assert.equal(projects[0].cwd, project)
    const sessions = await (await get(`/api/sessions?cwd=${encodeURIComponent(project)}`, { cookie })).json()
    assert.equal(sessions[0].id, 's1')
    const recap = await (await get('/api/recap?agent=claude&id=s1', { cookie })).json()
    assert.equal(recap.canWrite, false)
  })

  test('a write needs the custom header, and a model', async () => {
    const cookie = `sr_token=${token}`
    const noHeader = await fetch(`${base}/api/recap?agent=claude&id=s1`, { method: 'POST', headers: { cookie } })
    assert.equal(noHeader.status, 403)
    const noModel = await fetch(`${base}/api/recap?agent=claude&id=s1`, {
      method: 'POST',
      headers: { cookie, 'x-session-recap': '1' },
    })
    assert.equal(noModel.status, 409)
    assert.match((await noModel.json()).error, /No model is configured/)
  })
})
