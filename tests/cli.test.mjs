// Tests for cli/session-recap.mjs: config, model calls, and whole runs
// against a fake model server and synthetic sessions.
// Run: node --test tests/cli.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { detectAgent, estimateTokens, makeComplete, modelConfig, skillText } from '../cli/session-recap.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'session-recap.mjs')

describe('detectAgent', () => {
  test('reads the marker each agent sets', () => {
    assert.equal(detectAgent({ CLAUDECODE: '1' }), 'claude')
    assert.equal(detectAgent({ CODEX_SANDBOX: 'seatbelt' }), 'codex')
    assert.equal(detectAgent({ OPENCODE: '1' }), 'opencode')
    assert.equal(detectAgent({ DSH_SESSION: 'x' }), 'dsh')
    assert.equal(detectAgent({}), 'any')
    // Where an agent keeps its files is a person's setting, not a marker.
    assert.equal(detectAgent({ CODEX_HOME: '/x', DSH_HOME: '/y' }), 'any')
  })
})

describe('modelConfig', () => {
  test('session-recap settings win over provider variables', () => {
    const c = modelConfig(
      {},
      {
        SESSION_RECAP_BASE_URL: 'http://gw',
        SESSION_RECAP_API_KEY: 'k',
        SESSION_RECAP_MODEL: 'm',
        ANTHROPIC_API_KEY: 'a',
      },
    )
    assert.deepEqual([c.api, c.baseUrl, c.apiKey, c.model, c.partModel], ['openai', 'http://gw', 'k', 'm', 'm'])
  })

  test('Anthropic variables, with a gateway and a token', () => {
    const c = modelConfig({}, { ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'http://gw', ANTHROPIC_MODEL: 'big' })
    assert.deepEqual([c.api, c.baseUrl, c.bearer, c.model], ['anthropic', 'http://gw', true, 'big'])
  })

  test('SESSION_RECAP_API alone does not mix protocols with a detected key', () => {
    const c = modelConfig({}, { SESSION_RECAP_API: 'openai', SESSION_RECAP_MODEL: 'm', ANTHROPIC_API_KEY: 'a' })
    assert.deepEqual([c.api, c.baseUrl, c.model], ['anthropic', 'https://api.anthropic.com', 'm'])
  })

  test('DeepSeek and OpenAI keys', () => {
    assert.equal(modelConfig({}, { DEEPSEEK_API_KEY: 'd' }).baseUrl, 'https://api.deepseek.com')
    const o = modelConfig({ model: 'gpt-x' }, { OPENAI_API_KEY: 'o' })
    assert.deepEqual([o.baseUrl, o.model], ['https://api.openai.com/v1', 'gpt-x'])
  })
})

describe('makeComplete', () => {
  const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) })

  test('speaks the Anthropic Messages API and counts usage', async () => {
    const usage = { calls: 0, input: 0, output: 0 }
    let seen
    const complete = makeComplete(
      { api: 'anthropic', baseUrl: 'http://gw/', apiKey: 'k', model: 'big', partModel: 'small' },
      usage,
      async (url, init) => {
        seen = { url, init, body: JSON.parse(init.body) }
        return reply(200, { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 2 } })
      },
    )
    assert.equal(await complete({ stage: 'part', system: 's', prompt: 'p', maxTokens: 9 }), 'hi')
    assert.equal(seen.url, 'http://gw/v1/messages')
    assert.equal(seen.init.headers['x-api-key'], 'k')
    assert.deepEqual([seen.body.model, seen.body.system, seen.body.max_tokens], ['small', 's', 9])
    assert.deepEqual(usage, { calls: 1, input: 5, output: 2 })
  })

  test('speaks OpenAI chat completions and retries a 429', async () => {
    let calls = 0
    const complete = makeComplete(
      { api: 'openai', baseUrl: 'http://gw', apiKey: 'k', model: 'm', partModel: 'm' },
      { calls: 0, input: 0, output: 0 },
      async (url, init) => {
        calls += 1
        assert.equal(url, 'http://gw/chat/completions')
        assert.equal(init.headers.authorization, 'Bearer k')
        if (calls === 1) return reply(429, { error: 'slow down' })
        return reply(200, {
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })
      },
    )
    assert.equal(await complete({ stage: 'merge', system: 's', prompt: 'p', maxTokens: 9 }), 'ok')
    assert.equal(calls, 2)
  })

  test('runs at most four calls at once', async () => {
    let now = 0
    let peak = 0
    const complete = makeComplete(
      { api: 'openai', baseUrl: 'http://gw', apiKey: 'k', model: 'm', partModel: 'm' },
      { calls: 0, input: 0, output: 0 },
      async () => {
        now += 1
        peak = Math.max(peak, now)
        await new Promise(r => setTimeout(r, 10))
        now -= 1
        return reply(200, { choices: [{ message: { content: 'x' } }] })
      },
    )
    await Promise.all(
      Array.from({ length: 10 }, () => complete({ stage: 'part', system: '', prompt: '', maxTokens: 1 })),
    )
    assert.equal(peak, 4)
  })

  test('a 4xx fails with the status', async () => {
    const complete = makeComplete(
      { api: 'openai', baseUrl: 'http://gw', apiKey: 'k', model: 'm', partModel: 'm' },
      { calls: 0, input: 0, output: 0 },
      async () => reply(401, { error: 'bad key' }),
    )
    await assert.rejects(complete({ stage: 'merge', system: '', prompt: '', maxTokens: 1 }), /HTTP 401/)
  })
})

test('estimateTokens counts CJK characters as one token each', () => {
  assert.equal(estimateTokens('abcd'.repeat(10)), 10)
  assert.equal(estimateTokens('总结一下'), 4)
})

test('the skill names its agent', () => {
  assert.match(skillText('codex'), /session-recap --agent codex/)
  assert.match(skillText('any'), /^---\nname: session-recap\n/)
  assert.match(skillText('dsh', '"/n/node" "/c/cli.mjs"'), /"\/n\/node" "\/c\/cli.mjs" --agent dsh/)
})

// ------------------------------------------------------------ whole runs

describe('a whole run against a fake model server', () => {
  let home, project, server, url
  const requests = []

  before(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'session-recap-')))
    project = join(home, 'code', 'app')
    mkdirSync(project, { recursive: true })
    const folder = join(home, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(folder, { recursive: true })
    const lines = [1, 2].map(n =>
      JSON.stringify({
        parentUuid: null,
        type: 'user',
        cwd: project,
        timestamp: `2026-11-0${n}T10:00:00.000Z`,
        message: { role: 'user', content: `Step ${n} of the app` },
      }),
    )
    writeFileSync(join(folder, 's1.jsonl'), `${lines.join('\n')}\n`)
    server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/models') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: 'small' }, { id: 'fake' }] }))
        return
      }
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        requests.push(JSON.parse(body))
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            choices: [{ message: { content: `## Intent\nRecap ${requests.length}.` } }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
        )
      })
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${server.address().port}`
  })

  after(() => {
    server.close()
    rmSync(home, { recursive: true, force: true })
  })

  const run = (...args) =>
    runWith(
      {
        XDG_CONFIG_HOME: join(home, '.config'),
        SESSION_RECAP_BASE_URL: url,
        SESSION_RECAP_API_KEY: 'test',
        SESSION_RECAP_MODEL: 'fake',
      },
      args,
    )

  const runWith = (extra, args, stdin) =>
    new Promise((done, reject) => {
      const env = { PATH: process.env.PATH, HOME: home, XDG_CACHE_HOME: join(home, '.cache'), ...extra }
      const child = spawn(process.execPath, [CLI, ...args], { cwd: project, env })
      if (stdin !== undefined) child.stdin.end(stdin)
      let out = ''
      let err = ''
      child.stdout.on('data', c => (out += c))
      child.stderr.on('data', c => (err += c))
      child.on('error', reject)
      child.on('close', code => done({ code, out, err }))
    })

  test('recaps the newest session in the folder, then reuses it', async () => {
    const first = await run()
    assert.equal(first.code, 0, first.err)
    assert.match(first.out, /^# Step 1 of the app\n/)
    assert.match(first.out, /Claude Code · .* · new recap/)
    assert.match(first.out, /Recap 1\./)
    assert.match(first.err, /1 model call · 3 input \/ 2 output tokens/)
    assert.match(requests[0].messages[1].content, /\[USER 2026-11-01 10:00\] Step 1 of the app/)

    const second = await run()
    assert.match(second.out, /cached recap/)
    assert.equal(requests.length, 1)
  })

  test('a session that went on is updated from the new prompts only', async () => {
    const folder = join(home, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'))
    const line = {
      parentUuid: null,
      type: 'user',
      cwd: project,
      timestamp: '2026-11-03T10:00:00.000Z',
      message: { role: 'user', content: 'Step 3 of the app' },
    }
    appendFileSync(join(folder, 's1.jsonl'), `${JSON.stringify(line)}\n`)
    const r = await run('--agent', 'claude')
    assert.equal(r.code, 0, r.err)
    const prompt = requests.at(-1).messages[1].content
    assert.match(prompt, /<previous-recap>\n## Intent\nRecap 1\./)
    // The last covered prompt comes again, for how its turn ended.
    assert.match(prompt, /prompts 2 to 3/)
    assert.match(prompt, /Step 2 of the app/)
    assert.doesNotMatch(prompt, /Step 1 of the app/)
    assert.match(r.err, /updated from prompt 3/)
  })

  test('--dry-run reports the size and calls nothing', async () => {
    const before = requests.length
    const r = await run('--refresh', '--dry-run', '--json')
    const report = JSON.parse(r.out)
    assert.equal(report.mode, 'full recap')
    assert.equal(report.prompts, 3)
    assert.equal(report.modelCalls, 1)
    assert.equal(requests.length, before)
  })

  test('list and install', async () => {
    const list = await run('list', 'step 1')
    assert.match(list.out, /Claude Code .* Step 1 of the app/)
    mkdirSync(join(home, '.codex'), { recursive: true })
    const install = await run('install')
    assert.match(install.out, /installed .*\.codex\/skills\/session-recap\/SKILL\.md/)
    assert.match(install.out, /installed .*\.agents\/skills\/session-recap\/SKILL\.md/)
    assert.match(install.out, /skip opencode/)
    assert.deepEqual(readdirSync(join(home, '.codex', 'skills', 'session-recap')), ['SKILL.md'])
  })

  test('models lists what the provider offers and marks the ones in use', async () => {
    const r = await runWith(
      {
        XDG_CONFIG_HOME: join(home, '.config'),
        SESSION_RECAP_BASE_URL: url,
        SESSION_RECAP_API_KEY: 'test',
        SESSION_RECAP_MODEL: 'fake',
        SESSION_RECAP_PART_MODEL: 'gone',
      },
      ['models'],
    )
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /^● fake {3}← recap\n {2}small\n/)
    assert.match(r.out, /! parts model "gone" is not in this list/)
  })

  test('config set and unset save choices; the key comes from stdin only', async () => {
    const own = { XDG_CONFIG_HOME: join(home, 'own-config') }
    const file = join(home, 'own-config', 'session-recap', 'config.json')
    assert.equal((await runWith(own, ['config', 'set', 'baseUrl', url])).code, 0)
    assert.equal((await runWith(own, ['config', 'set', 'model', 'fake'])).code, 0)
    const refused = await runWith(own, ['config', 'set', 'apiKey', 'sk-in-history'])
    assert.equal(refused.code, 1)
    assert.match(refused.err, /from stdin/)
    assert.equal((await runWith(own, ['config', 'set', 'apiKey', '-'], 'sk-from-stdin\n')).code, 0)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { baseUrl: url, model: 'fake', apiKey: 'sk-from-stdin' })
    assert.equal(statSync(file).mode & 0o777, 0o600)

    const shown = await runWith(own, ['config'])
    assert.match(shown.out, /model: +fake/)
    assert.match(shown.out, /API key: +sk-f…tdin \(13 chars\)/)
    assert.doesNotMatch(shown.out, /sk-from-stdin/)

    // The saved settings are enough to write a recap.
    const recap = await runWith(own, ['--refresh'])
    assert.equal(recap.code, 0, recap.err)
    assert.match(recap.out, /## Intent/)

    assert.equal((await runWith(own, ['config', 'unset', 'model'])).code, 0)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['baseUrl', 'apiKey'])
    assert.equal((await runWith(own, ['config', 'set', 'color', 'red'])).code, 1)
  })

  test('list shows the sessions of the agent it runs in; --all shows every agent', async () => {
    const codex = await runWith({ XDG_CONFIG_HOME: join(home, '.config'), CODEX_THREAD_ID: 't' }, ['list'])
    assert.doesNotMatch(codex.out, /Step 1 of the app/)
    const all = await runWith({ XDG_CONFIG_HOME: join(home, '.config'), CODEX_THREAD_ID: 't' }, ['list', '--all'])
    assert.match(all.out, /Claude Code .* Step 1 of the app/)
  })

  test('no model configured is a clear error', async () => {
    const child = spawn(process.execPath, [CLI, '--refresh'], {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CACHE_HOME: join(home, '.cache'),
        XDG_CONFIG_HOME: join(home, '.config'),
      },
    })
    let err = ''
    child.stderr.on('data', c => (err += c))
    const code = await new Promise(r => child.on('close', r))
    assert.equal(code, 2)
    assert.match(err, /no model configured/)
  })
})
