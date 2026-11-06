// dsh-session-recap: the session_recap tool and the /recap command for
// DeepSeek Harness (dsh). A cordis plugin, mounted by cordis.patch.yml.

import Schema from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { panelRoute, recapCommand, recapTool } from './recap.js'

export const name = 'dsh-session-recap'
export const inject = ['llm', 'tools']

export const Config = Schema.object({
  provider: Schema.string().description('Provider for recaps; empty: the session’s own'),
  model: Schema.string().description('Model for recaps; empty: the session’s own'),
})

// One text reply from the host's model runtime.
async function chatText(llm, system, user, { route, timeoutMs = 300_000 }) {
  const assembler = new BlockAssembler()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [
        { role: 'system', content: [{ type: 'text', text: system }] },
        createUserMessage({ content: [{ type: 'text', text: user }] }),
      ],
      signal: controller.signal,
    })) {
      assembler.push(chunk)
    }
  } finally {
    clearTimeout(timer)
  }
  // The runtime reports a failed call (no key, quota, network) as the stream's
  // finish reason, not by throwing: an empty reply is never a recap.
  const finish = assembler.finish
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    throw new Error(`${route.model}: ${finish.failure?.code ?? finish.kind}: ${finish.failure?.message ?? 'no reply'}`)
  }
  const message = assembler.message({ provider: route.provider, model: route.model })

  return (message.content ?? [])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
}

export function apply(ctx, config) {
  const deps = { defineTool, chatText, llm: ctx.llm, config }
  ctx.tools.register(recapTool(deps))
  // The command is optional: a host without the commands service still has the tool.
  try {
    ctx.inject(['commands'], commandsCtx => {
      commandsCtx.commands.register(recapCommand(deps))
    })
  } catch (err) {
    console.error(`[dsh-session-recap] /recap not registered: ${err instanceof Error ? err.message : err}`)
  }
  // The web panel's read route, behind dsh's own browser authentication.
  try {
    ctx.inject(['connection'], connectionCtx => {
      connectionCtx.effect(
        () => connectionCtx.connection.fetch.register(panelRoute(deps)),
        'session-recap: panel route',
      )
    })
  } catch (err) {
    console.error(`[dsh-session-recap] panel route not registered: ${err instanceof Error ? err.message : err}`)
  }
}
