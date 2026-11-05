// session-recap as an MCP server (stdio, JSON-RPC 2.0, newline-delimited).
// Any MCP client (Codex, Cursor, Zed, Cline, Gemini CLI, OpenCode, dsh, ...)
// gets three tools: list_sessions, recap_session and save_recap.
//
// With no model of its own configured, recap_session hands the condensed
// transcript and the recap format to the calling agent, which writes the
// recap with its own model and stores it back with save_recap.

import { createInterface } from 'node:readline'

import { FORMAT_NAMES } from '../core/formats.mjs'
import { formatText, recapRequest, splitRecap, writeRecap } from '../core/recap.mjs'
import {
  AGENTS,
  LABEL,
  detectAgent,
  isFreshFor,
  makeComplete,
  modelConfig,
  noteFiles,
  python,
  readCached,
  saveCached,
} from './session-recap.mjs'

/** @typedef {import('./session-recap.mjs').Session} Session */
/** @typedef {import('../core/recap.mjs').Digest} Digest */

// The transcript an agent is asked to recap itself must fit its context.
const AGENT_BUDGET = 60_000
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

const AGENT_ENUM = [...AGENTS, 'any']

export const TOOLS = [
  {
    name: 'list_sessions',
    title: 'List AI coding sessions',
    description:
      'Lists saved sessions of Claude Code, Codex, dsh and OpenCode on this machine, newest first: agent, id, title, ' +
      'project folder, last activity. Filter by words in the title, by project folder, or by agent.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words in the title, or a session id' },
        cwd: { type: 'string', description: 'Only sessions of this project folder (absolute path)' },
        agent: { type: 'string', enum: AGENT_ENUM, description: 'Only this agent; "any" for all (default)' },
        limit: { type: 'number', description: 'At most this many (default 20)' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'recap_session',
    title: 'Recap a session',
    description:
      'Recaps a coding session: intent, key decisions, what changed, open threads, where to resume. With no session ' +
      'given, the newest session of the calling agent in `cwd`. Returns a stored recap when the session has not ' +
      'changed since. Otherwise, if session-recap has a model configured it writes the recap; if not, it returns the ' +
      'condensed transcript and instructions, and you write the recap yourself and store it with save_recap.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'A session id or words in its title; empty for the current session' },
        cwd: { type: 'string', description: 'The project folder you are working in (absolute path)' },
        agent: {
          type: 'string',
          enum: AGENT_ENUM,
          description: 'The agent whose sessions to look in; default: the caller',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'agent', 'model'],
          description: '"agent": you write it; "model": session-recap writes it; "auto" (default): model if configured',
        },
        refresh: { type: 'boolean', description: 'Write it again even if a stored recap is current' },
        format: {
          type: 'string',
          enum: FORMAT_NAMES,
          description:
            '"recap" (default: intent, decisions, changes, open threads, resume), "standup", "handoff" or "pr"',
        },
      },
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'save_recap',
    title: 'Store a recap you wrote',
    description:
      'Stores the recap you wrote for a session after recap_session returned its transcript, so the next recap of ' +
      'that session is reused or updated from it. Pass the agent, id and prompts recap_session gave you.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: AGENTS },
        id: { type: 'string' },
        prompts: { type: 'number', description: 'The prompt count recap_session reported' },
        markdown: { type: 'string', description: 'The recap, in the format recap_session asked for' },
      },
      required: ['agent', 'id', 'prompts', 'markdown'],
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
]

/** @param {string | undefined} agent */
function agentOf(agent) {
  if (agent === undefined || agent === 'auto') return detectAgent()
  if (agent !== 'any' && !AGENTS.includes(/** @type {any} */ (agent))) throw new Error(`unknown agent "${agent}"`)
  return agent
}

/**
 * @param {{ session?: string, cwd?: string, agent?: string }} args
 * @returns {Session}
 */
function findSession(args) {
  const agent = agentOf(args.agent)
  if (args.session === undefined || args.session.trim() === '') {
    const row = python(['current', agent, args.cwd ?? process.cwd()])
    if (row === null)
      throw new Error(`no ${agent === 'any' ? '' : `${LABEL[agent]} `}session in ${args.cwd ?? process.cwd()}`)
    return row
  }
  /** @type {Session[]} */
  const rows = python(['find', args.session]).filter((/** @type {Session} */ r) => agent === 'any' || r.agent === agent)
  const hit = rows[0]
  if (hit === undefined) throw new Error(`no session matches "${args.session}"`)
  return hit
}

/**
 * @param {Session} session
 * @param {string} markdown
 * @param {string} note
 */
function recapResult(session, markdown, note, format = 'recap') {
  const { markdown: text, map } = splitRecap(markdown)
  return {
    content: [
      { type: 'text', text: `# ${session.title}\n\n> ${LABEL[session.agent]} · ${session.cwd} · ${note}\n\n${text}` },
    ],
    structuredContent: { schemaVersion: 1, mode: 'recap', format, session, markdown: text, map: map ?? null },
  }
}

/** @type {Record<string, (args: any) => Promise<object>>} */
const HANDLERS = {
  async list_sessions(args) {
    const agent = agentOf(args.agent ?? 'any')
    const limit = Math.max(1, Math.min(200, Number(args.limit ?? 20)))
    /** @type {Session[]} */
    let rows = python(args.query ? ['find', args.query] : args.cwd ? ['sessions', args.cwd] : ['all'])
    rows = rows.filter(r => (agent === 'any' || r.agent === agent) && (!args.cwd || r.cwd === args.cwd)).slice(0, limit)
    const lines = rows.map(
      r =>
        `- ${LABEL[r.agent]} · ${r.title} · ${new Date(r.mtimeMs).toISOString().slice(0, 16)} · ${r.cwd} · id ${r.id}`,
    )
    return {
      content: [{ type: 'text', text: rows.length === 0 ? 'No sessions found.' : lines.join('\n') }],
      structuredContent: { sessions: rows },
    }
  },

  async recap_session(args) {
    const session = findSession(args)
    const format = args.format ?? 'recap'
    formatText(format)
    // Only recaps are stored; another format is written whole each time.
    const isRecap = format === 'recap'
    const previous = args.refresh || !isRecap ? undefined : readCached(session)
    if (isFreshFor(previous, session) && previous !== undefined)
      return recapResult(session, previous.markdown, 'stored recap')
    const from = previous?.prompts !== undefined ? previous.prompts : 0
    const config = modelConfig()
    const hasModel = Boolean(config.apiKey && config.baseUrl && config.model)
    const mode = args.mode ?? 'auto'
    if (mode === 'model' && !hasModel) throw new Error('no model configured for session-recap; use mode "agent"')

    let fallback = ''
    if (mode === 'model' || (mode === 'auto' && hasModel)) {
      /** @type {Digest} */
      const digest = python(['digest', session.agent, session.path, String(from)])
      const usage = { calls: 0, input: 0, output: 0 }
      try {
        const markdown = await writeRecap({
          digest,
          previous: from > 0 ? previous : undefined,
          complete: makeComplete(config, usage),
          notes: noteFiles,
          format,
        })
        if (isRecap) saveCached(session, digest.prompts, markdown, config.model)
        return recapResult(session, markdown, `new ${format} by ${config.model}`, format)
      } catch (err) {
        if (mode === 'model') throw err
        // auto: the configured model failed, so the caller writes it instead.
        fallback = ` (session-recap's own model failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)})`
      }
    }

    // The caller writes it: a transcript condensed to fit one context.
    /** @type {Digest} */
    const digest = python(['digest', session.agent, session.path, String(from), String(AGENT_BUDGET)])
    if (from > 0 && previous !== undefined && digest.text.trim() === '') {
      return recapResult(session, previous.markdown, 'stored recap')
    }
    const { system, prompt } = recapRequest({ digest, previous: from > 0 ? previous : undefined, format })
    const steps = isRecap
      ? `Write this recap yourself${fallback}, then call save_recap with agent "${session.agent}", id "${session.id}", ` +
        `prompts ${digest.prompts} and your whole reply (the Markdown and the json recap-map block). ` +
        `Show the person the Markdown part, not the json block.`
      : `Write this ${format} yourself${fallback} and show it to the person (it is not stored).`
    const note = digest.redactions ? ` ${digest.redactions} secrets were removed from the transcript.` : ''
    return {
      content: [{ type: 'text', text: `${steps}${note}\n\n<instructions>\n${system}\n</instructions>\n\n${prompt}` }],
      structuredContent: {
        schemaVersion: 1,
        mode: 'agent',
        format,
        session,
        prompts: digest.prompts,
        redactions: digest.redactions ?? 0,
        system,
        prompt,
      },
    }
  },

  async save_recap(args) {
    if (typeof args.markdown !== 'string' || args.markdown.trim() === '') throw new Error('markdown is empty')
    /** @type {Session[]} */
    const rows = python(['find', String(args.id)])
    const session = rows.find(r => r.agent === args.agent && r.id === args.id)
    if (session === undefined) throw new Error(`no ${args.agent} session with id ${args.id}`)
    const saved = saveCached(session, Number(args.prompts) || 0, args.markdown, 'the calling agent')
    return {
      content: [{ type: 'text', text: `Stored the recap of "${session.title}".` }],
      structuredContent: { saved: true, at: saved.at },
    }
  },
}

/**
 * Answers one JSON-RPC message; resolves the response, or undefined for a notification.
 * @param {any} msg
 * @param {string} version
 */
export async function handle(msg, version) {
  const reply = (/** @type {object} */ result) => ({ jsonrpc: '2.0', id: msg.id, result })
  const error = (/** @type {number} */ code, /** @type {string} */ message) => ({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code, message },
  })
  if (msg === null || typeof msg !== 'object' || msg.jsonrpc !== '2.0')
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }
  const isNotification = msg.id === undefined || msg.id === null
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'session-recap', title: 'session-recap', version },
        instructions:
          'Recaps AI coding sessions. Call recap_session (with cwd) when the person asks what this or an earlier ' +
          'session was about, where they left off, or for a recap or summary. If it returns instructions instead of a ' +
          'recap, follow them and store the result with save_recap.',
      })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call': {
      const handler = HANDLERS[msg.params?.name]
      if (handler === undefined) return error(-32602, `unknown tool ${msg.params?.name}`)
      try {
        return reply(await handler(msg.params?.arguments ?? {}))
      } catch (err) {
        return reply({
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        })
      }
    }
    default:
      return isNotification ? undefined : error(-32601, `method not found: ${msg.method}`)
  }
}

/**
 * Serves MCP on stdin/stdout until stdin closes. Nothing else may write to stdout.
 * @param {string} version
 */
export function serveMcp(version) {
  const lines = createInterface({ input: process.stdin })
  lines.on('line', async line => {
    if (line.trim() === '') return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`,
      )
      return
    }
    const out = await handle(msg, version)
    if (out !== undefined) process.stdout.write(`${JSON.stringify(out)}\n`)
  })
  return new Promise(done => lines.on('close', done))
}
