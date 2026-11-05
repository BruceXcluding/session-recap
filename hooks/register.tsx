import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { writeRecap } from '../core/recap.mjs'
import type { Digest } from '../core/recap.mjs'
import type { Job, ProjectRow, Recap, SessionRow, View } from '../types'

const PANE = 'session-recap'
const TITLE = 'Session recap'
const SESSIONS_SHOWN = 60
// The plugin's store holds 4 MiB of JSON in all, past which every write fails:
// keep the newest recaps (a few KB each) and part notes, drop the rest.
const RECAPS_KEPT = 250
const NOTES_KEPT = 100

const AGENT_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'dsh',
  opencode: 'OpenCode',
}

const view = atom(
  { plugin: 'session-recap', key: 'view' } as const,
  { screen: 'projects', projects: [], sessions: [] },
  { shape: 'view-3' },
)
const jobs = atom(
  { plugin: 'session-recap', key: 'jobs' } as const,
  {},
  {
    shape: 'jobs-3',
  },
)

type SectionKey = 'intent' | 'ideas' | 'changed' | 'open' | 'resume'
// The recap's headings, in the order RECAP_FORMAT asks for them; a model
// that translates a heading is still matched, by the words or by position.
const SECTIONS: { key: SectionKey; label: string; match: RegExp }[] = [
  { key: 'intent', label: 'Intent', match: /intent|意图|目标/i },
  { key: 'ideas', label: 'Decisions', match: /idea|decision|决策|想法|思路/i },
  { key: 'changed', label: 'Changes', match: /chang|变更|改动|产出|成果/i },
  { key: 'open', label: 'Open threads', match: /open|thread|未完成|待办|遗留/i },
  { key: 'resume', label: 'Resume', match: /resume|继续|下一步|接着/i },
]

function sectionsOf(markdown: string): Partial<Record<SectionKey, string>> {
  const out: Partial<Record<SectionKey, string>> = {}
  const parts = markdown.split(/^##\s+/m).slice(1)
  parts.forEach((part, i) => {
    const newline = part.indexOf('\n')
    const heading = newline < 0 ? part : part.slice(0, newline)
    const body = newline < 0 ? '' : part.slice(newline + 1).trim()
    const key = SECTIONS.find(s => s.match.test(heading))?.key ?? SECTIONS[i]?.key
    if (key !== undefined && out[key] === undefined) out[key] = body
  })

  return out
}

function oneLine(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined
  const line = text
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

// A file's mtime may come back with or without its fraction, so versions
// compare within a second.
function isSameVersion(a: { size: number; mtimeMs: number }, b: { size: number; mtimeMs: number }): boolean {
  return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1000
}

function errorText(err: unknown): string {
  return String(err).replace(/^Error: /, '')
}

function keyOf(s: { agent: string; id: string }): string {
  return `${s.agent}:${s.id}`
}

async function python($: EngineInterface, args: string[]): Promise<unknown> {
  const script = `${$.plugin.root}/hooks/digest.py`
  let lastError = ''
  for (const exe of ['python3', '/usr/bin/python3']) {
    try {
      const r = await $.process.run([exe, '-I', script, ...args], { timeoutMs: 180_000 })
      if (r.exitCode === 0) return JSON.parse(r.stdout)
      lastError = r.stderr.trim().split('\n').at(-1) ?? `exit ${r.exitCode}`
    } catch (err) {
      lastError = String(err)
    }
  }
  throw new Error(`digest.py failed: ${lastError}`)
}

async function stored($: EngineInterface, s: { agent: string; id: string }): Promise<Recap | undefined> {
  const recap = (await $.store.get(`recap:${keyOf(s)}`)) as Recap | undefined
  // Version 0.2 kept Claude Code recaps under the session id alone.
  if (recap === undefined && s.agent === 'claude') return (await $.store.get(`recap:${s.id}`)) as Recap | undefined

  return recap
}

async function withRecapMarks($: EngineInterface, rows: SessionRow[]): Promise<SessionRow[]> {
  return Promise.all(
    rows.map(async row => {
      const recap = await stored($, row)
      if (recap === undefined) return row
      const intent = oneLine(sectionsOf(recap.markdown).intent, 160)

      return { ...row, recap: isSameVersion(recap, row) ? 'fresh' : 'stale', intent } as SessionRow
    }),
  )
}

async function showProjects($: EngineInterface): Promise<void> {
  try {
    const projects = (await python($, ['projects'])) as ProjectRow[]
    await update($, view, v => ({ ...v, screen: 'projects' as const, projects, error: undefined }))
  } catch (err) {
    await update($, view, v => ({ ...v, screen: 'projects' as const, error: errorText(err) }))
  }
}

async function showSessions($: EngineInterface, project: ProjectRow): Promise<void> {
  try {
    const rows = (await python($, ['sessions', project.cwd])) as SessionRow[]
    const sessions = await withRecapMarks($, rows.slice(0, SESSIONS_SHOWN))
    await update($, view, v => ({
      ...v,
      screen: 'sessions' as const,
      project,
      sessions,
      agent: v.project?.cwd === project.cwd ? v.agent : undefined,
      error: undefined,
    }))
  } catch (err) {
    await update($, view, v => ({ ...v, screen: 'sessions' as const, project, error: errorText(err) }))
  }
}

async function showRecap($: EngineInterface, session: SessionRow): Promise<void> {
  const recap = await stored($, session)
  await update($, view, v => ({
    ...v,
    screen: 'recap' as const,
    session,
    recap,
    section: 'all' as const,
    error: undefined,
  }))
}

async function setJob($: EngineInterface, key: string, job: Job | undefined): Promise<void> {
  await update($, jobs, all => {
    const next = { ...all }
    if (job === undefined) delete next[key]
    else next[key] = job

    return next
  })
}

type Note = { note: string; at: number }

// Part notes by content hash. Each is its own key, so parts condensed in
// parallel never write the same entry; prune() trims them afterwards.
function noteCache($: EngineInterface) {
  return {
    get: async (key: string) => ((await $.store.get(`note:${key}`)) as Note | undefined)?.note,
    set: (key: string, note: string) => $.store.set(`note:${key}`, { note, at: Date.now() } satisfies Note),
  }
}

// Drops the oldest recaps and notes past their limits; runs once per recap,
// after the parallel work, so nothing else writes meanwhile.
async function prune($: EngineInterface): Promise<void> {
  const keys = await $.store.keys()
  const dated = async (prefix: string) =>
    Promise.all(
      keys
        .filter(k => k.startsWith(prefix))
        .map(async k => ({ k, at: Number(((await $.store.get(k)) as { at?: number } | undefined)?.at ?? 0) })),
    )
  for (const [prefix, kept] of [
    ['recap:', RECAPS_KEPT],
    ['note:', NOTES_KEPT],
  ] as const) {
    const rows = (await dated(prefix)).sort((a, b) => b.at - a.at)
    for (const { k } of rows.slice(kept)) await $.store.delete(k)
  }
  // Version 0.3.0 kept a list of note keys; the dates replace it.
  if (keys.includes('notes')) await $.store.delete('notes')
}

async function summarize($: EngineInterface, session: SessionRow, partModel: string): Promise<void> {
  const key = keyOf(session)
  if ((await read($, jobs))[key] !== undefined) return
  try {
    await setJob($, key, { step: 'Reading the transcript', done: 0, total: 0 })
    await update($, view, v => (v.session && keyOf(v.session) === key ? { ...v, error: undefined } : v))
    // The session's own model: the one the person's provider surely serves.
    const model = await $.session.model()
    const previous = await stored($, session)
    // A recap that knows how many prompts it covers is brought up to date
    // from there; any other is written again from the start.
    const from = previous?.prompts !== undefined && !isSameVersion(previous, session) ? previous.prompts : 0
    const digest = (await python($, ['digest', session.agent, session.path, String(from)])) as Digest
    const markdown = await writeRecap({
      digest,
      previous: from > 0 ? previous : undefined,
      notes: noteCache($),
      progress: job => setJob($, key, { ...job, step: `${job.step} with ${model}` }),
      complete: async request => {
        const use = request.stage === 'part' && partModel !== '' ? partModel : model
        const r = await $.model.complete({ ...request, model: use, timeoutMs: 300_000 })
        if (!r.isAnswered) {
          const why = r.reason === 'api-error' ? `api-error ${r.status ?? ''}` : r.reason
          throw new Error(`${use} gave no answer (${why})`)
        }

        return r.text
      },
    })
    const recap: Recap = {
      size: session.size,
      mtimeMs: session.mtimeMs,
      at: Date.now(),
      markdown,
      prompts: digest.prompts,
    }
    await $.store.set(`recap:${key}`, recap)
    if (session.agent === 'claude') await $.store.delete(`recap:${session.id}`)
    await prune($)
    await update($, view, v => {
      const intent = oneLine(sectionsOf(markdown).intent, 160)
      const sessions = v.sessions.map(s => (keyOf(s) === key ? { ...s, recap: 'fresh' as const, intent } : s))

      return v.session && keyOf(v.session) === key ? { ...v, sessions, recap, error: undefined } : { ...v, sessions }
    })
    await setJob($, key, undefined)
    $.ui.toast(`Recap ready: ${session.title.slice(0, 60)}`)
  } catch (err) {
    await setJob($, key, undefined)
    await update($, view, v => (v.session && keyOf(v.session) === key ? { ...v, error: errorText(err) } : v))
  }
}

type Context = { projects: ProjectRow[]; session: SessionRow | null; sessions: SessionRow[] }

// One scan: the projects, the session matching `query` and its project's
// sessions, all put in the view. Resolves the matched session, marked.
async function lookUp($: EngineInterface, query: string): Promise<{ projects: ProjectRow[]; session?: SessionRow }> {
  const found = (await python($, ['context', query])) as Context
  if (found.session === null) {
    await update($, view, v => ({ ...v, projects: found.projects }))
    return { projects: found.projects }
  }
  const hit = found.session
  const project = found.projects.find(p => p.cwd === hit.cwd)
  const sessions = await withRecapMarks($, found.sessions.slice(0, SESSIONS_SHOWN))
  await update($, view, v => ({ ...v, projects: found.projects, project, sessions, agent: undefined }))
  const session = sessions.find(s => keyOf(s) === keyOf(hit)) ?? (await withRecapMarks($, [hit]))[0] ?? hit

  return { projects: found.projects, session }
}

async function currentSession($: EngineInterface): Promise<SessionRow | undefined> {
  const { session } = await lookUp($, await $.session.id())

  return session?.agent === 'claude' ? session : undefined
}

function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000)
  if (min < 60) return `${Math.max(0, min)}m ago`
  if (min < 48 * 60) return `${Math.round(min / 60)}h ago`

  return `${Math.round(min / 1440)}d ago`
}

function megabytes(n: number): string {
  return n < 1_000_000 ? `${Math.max(1, Math.round(n / 1000))} KB` : `${(n / 1_000_000).toFixed(1)} MB`
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

type Found = { kind: 'project'; project: ProjectRow } | { kind: 'session'; session: SessionRow }

// A project whose folder name holds the query wins; else a session whose
// title or id does, newest first.
async function findByName($: EngineInterface, query: string): Promise<Found | undefined> {
  const q = query.toLowerCase()
  const { projects, session } = await lookUp($, query)
  const project =
    projects.find(p => baseName(p.cwd).toLowerCase() === q) ??
    projects.find(p => baseName(p.cwd).toLowerCase().includes(q))
  if (project !== undefined) return { kind: 'project', project }

  return session === undefined ? undefined : { kind: 'session', session }
}

export const register: Register = (on, options) => {
  const partModel = typeof options.partModel === 'string' ? options.partModel.trim() : ''

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-recap',
      description:
        'Recap this session; "/session-recap browse" lists every project and agent, "/session-recap <name>" opens a project or session by name',
      argumentHint: '[browse | project or session name]',
    })

    return next(e)
  })

  on('command.run', { command: 'session-recap' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })
    const query = e.args.trim()
    if (query === 'browse') {
      await showProjects($)
      return { text: 'Session recap pane opened.' }
    }
    if (query !== '') {
      const found = await findByName($, query)
      if (found === undefined) {
        await showProjects($)
        await update($, view, v => ({ ...v, error: `No project or session matches "${query}".` }))
        return { text: `No project or session matches "${query}"; showing all projects.` }
      }
      if (found.kind === 'project') {
        await showSessions($, found.project)
        return { text: `Showing the sessions of ${baseName(found.project.cwd)}.` }
      }
      await showRecap($, found.session)
      if (found.session.recap !== 'fresh') void summarize($, found.session, partModel)
      return { text: `Writing a recap of "${found.session.title.slice(0, 60)}".` }
    }
    const session = await currentSession($)
    if (session === undefined) {
      await showProjects($)
      return { text: 'This session has no saved transcript yet; showing all projects.' }
    }
    await showRecap($, session)
    if (session.recap !== 'fresh') void summarize($, session, partModel)

    return { text: 'Writing a recap of this session in the Session recap pane.' }
  }).catch(() => ({ text: 'Session recap could not open; see the debug log.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const v = await read($, view)
    const running = await read($, jobs)
    const width = e.props.bodyColumns

    const progress = (job: Job) => {
      const cells = 12
      const filled = job.total > 0 ? Math.round((job.done / job.total) * cells) : 0
      const bar = job.total > 0 ? `${'▰'.repeat(filled)}${'▱'.repeat(cells - filled)}  ` : ''

      return `${bar}${job.step}…`
    }

    const errorCard = (onRetry?: () => void) =>
      v.error !== undefined && (
        <Box flexDirection="column" gap="xs" borderStyle="round" borderColor="error" paddingX={1}>
          <Text color="error" weight="semibold">
            Something went wrong
          </Text>
          <Text color="error">{v.error}</Text>
          {onRetry !== undefined && (
            <Button key="retry" onPress={onRetry}>
              Try again
            </Button>
          )}
        </Box>
      )

    const agentsLine = (agents: Record<string, number>) =>
      Object.entries(agents)
        .map(([agent, n]) => `${AGENT_LABEL[agent] ?? agent} ${n}`)
        .join(' · ')

    if (v.screen === 'projects') {
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text size="heading" weight="bold">
              Projects
            </Text>
            <Text dimColor size="footnote">
              Sessions from Claude Code, Codex, dsh and OpenCode, by project folder, newest first.
            </Text>
          </Box>
          {errorCard()}
          {v.projects.length === 0 && v.error === undefined && <Text dimColor>Loading projects…</Text>}
          <Box flexDirection="column" gap="sm">
            {v.projects.map(p => (
              <Box flexDirection="column">
                <Button key={p.cwd} plain onPress={() => void showSessions($, p)}>
                  <Text weight="semibold">{baseName(p.cwd)}</Text>
                  {'  '}
                  <Text dimColor>
                    {p.sessions} {p.sessions === 1 ? 'session' : 'sessions'} · {ago(p.mtimeMs)}
                  </Text>
                </Button>
                <Text dimColor size="footnote">
                  {agentsLine(p.agents)} · {p.cwd}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    if (v.screen === 'sessions') {
      const recapped = v.sessions.filter(s => s.recap !== undefined).length
      const agents = [...new Set(v.sessions.map(s => s.agent))]
      const shown = v.sessions.filter(s => v.agent === undefined || s.agent === v.agent)
      const filter = (agent: string | undefined) => () => void update($, view, w => ({ ...w, agent }))

      return (
        <Box flexDirection="column" gap={1}>
          <Button key="to-projects" plain dimColor onPress={() => void showProjects($)}>
            ‹ All projects
          </Button>
          <Box flexDirection="column">
            <Text size="heading" weight="bold">
              {baseName(v.project?.cwd ?? '')}
            </Text>
            <Text dimColor size="footnote">
              {v.sessions.length} sessions · {recapped} recapped
            </Text>
          </Box>
          {agents.length > 1 && (
            <Box flexDirection="row" gap="sm" flexWrap="wrap">
              <Button
                key="agent-all"
                variant={v.agent === undefined ? 'primary' : 'secondary'}
                onPress={filter(undefined)}
              >
                All
              </Button>
              {agents.map(agent => (
                <Button
                  key={`agent-${agent}`}
                  variant={v.agent === agent ? 'primary' : 'secondary'}
                  onPress={filter(agent)}
                >
                  {AGENT_LABEL[agent] ?? agent}
                </Button>
              ))}
            </Box>
          )}
          {errorCard()}
          <Box flexDirection="column" gap="sm">
            {shown.map(s => {
              const job = running[keyOf(s)]
              const mark =
                s.recap === 'fresh' ? (
                  <Text color="success">●</Text>
                ) : s.recap === 'stale' ? (
                  <Text color="warning">◐</Text>
                ) : (
                  <Text dimColor>○</Text>
                )

              return (
                <Box flexDirection="column">
                  <Button key={keyOf(s)} plain onPress={() => void showRecap($, s)}>
                    {mark} <Text weight="semibold">{s.title.slice(0, Math.max(20, width - 34))}</Text>
                    {'  '}
                    <Text dimColor>
                      {AGENT_LABEL[s.agent] ?? s.agent} · {ago(s.mtimeMs)} · {megabytes(s.size)}
                    </Text>
                  </Button>
                  {job !== undefined ? (
                    <Text color="warning" size="footnote">
                      {' '}
                      {progress(job)}
                    </Text>
                  ) : s.intent !== undefined ? (
                    <Text dimColor size="footnote">
                      {' '}
                      {s.intent}
                    </Text>
                  ) : null}
                </Box>
              )
            })}
          </Box>
          <Text dimColor size="caption">
            ● recap ready ◐ session changed since ○ no recap yet
          </Text>
        </Box>
      )
    }

    const s = v.session
    if (s === undefined) return <Text dimColor>No session picked.</Text>
    const job = running[keyOf(s)]
    const recap = v.recap
    const isStale = recap !== undefined && !isSameVersion(recap, s)
    const parts = recap !== undefined ? sectionsOf(recap.markdown) : {}
    const isStructured = parts.intent !== undefined
    const section = v.section ?? 'all'
    const detailKeys: SectionKey[] = section === 'all' ? ['ideas', 'changed', 'open'] : [section]
    const details = SECTIONS.filter(x => detailKeys.includes(x.key) && parts[x.key] !== undefined)
      .map(x => (section === 'all' ? `### ${x.label}\n\n${parts[x.key]}` : (parts[x.key] ?? '')))
      .join('\n\n')
    const pick = (next: NonNullable<View['section']>) => () => void update($, view, w => ({ ...w, section: next }))
    const write = () => void summarize($, s, partModel)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap="sm">
          <Button
            key="to-sessions"
            plain
            dimColor
            onPress={() => void (v.project ? showSessions($, v.project) : showProjects($))}
          >
            ‹ Sessions
          </Button>
          {recap !== undefined && (
            <Box flexDirection="row" gap="sm">
              <Button
                key="copy"
                onPress={pressed => void $.ui.copy({ text: recap.markdown, surface: pressed.surface })}
              >
                Copy
              </Button>
              {job === undefined && (
                <Button key="summarize" variant={isStale ? 'primary' : 'secondary'} onPress={write}>
                  {isStale ? 'Update recap' : 'Refresh recap'}
                </Button>
              )}
            </Box>
          )}
        </Box>

        <Box flexDirection="column">
          <Text size="title" weight="bold">
            {s.title}
          </Text>
          <Text dimColor size="footnote">
            {AGENT_LABEL[s.agent] ?? s.agent} · {baseName(s.cwd)} · {megabytes(s.size)} · active {ago(s.mtimeMs)}
            {recap ? ` · recap from ${ago(recap.at)}` : ''}
          </Text>
        </Box>

        {job !== undefined && (
          <Box flexDirection="column" gap="xs" borderStyle="round" borderColor="warning" paddingX={1}>
            <Text color="warning" weight="semibold">
              Writing the recap
            </Text>
            <Text>{progress(job)}</Text>
          </Box>
        )}
        {errorCard(job === undefined ? write : undefined)}
        {isStale && job === undefined && (
          <Text color="warning" size="footnote">
            The session has continued since this recap. Update reads only the newer part.
          </Text>
        )}

        {recap === undefined && job === undefined && v.error === undefined && (
          <Box flexDirection="column" gap="sm" borderStyle="round" borderColor="subtle" paddingX={1} paddingY="sm">
            <Text weight="semibold">No recap yet</Text>
            <Text dimColor>
              Reads the whole transcript and writes its intent, key decisions, changes, open threads and where to
              resume. It uses this session's model and costs some tokens.
            </Text>
            <Button key="summarize" variant="primary" autoFocus onPress={write}>
              Write recap
            </Button>
          </Box>
        )}

        {recap !== undefined && !isStructured && <Markdown text={recap.markdown} />}
        {recap !== undefined && isStructured && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column" gap="xs" borderStyle="round" borderColor="claude" paddingX={1}>
              <Text color="claude" size="caption" weight="bold">
                INTENT
              </Text>
              <Markdown text={parts.intent ?? ''} />
            </Box>
            {parts.resume !== undefined && (
              <Box flexDirection="column" gap="xs" borderStyle="round" borderColor="success" paddingX={1}>
                <Text color="success" size="caption" weight="bold">
                  WHERE TO RESUME
                </Text>
                <Markdown text={parts.resume} />
              </Box>
            )}
            <Box flexDirection="row" gap="sm" flexWrap="wrap">
              {(['all', 'ideas', 'changed', 'open'] as const).map(key => (
                <Button key={`tab-${key}`} variant={section === key ? 'primary' : 'secondary'} onPress={pick(key)}>
                  {key === 'all' ? 'All' : (SECTIONS.find(x => x.key === key)?.label ?? key)}
                </Button>
              ))}
            </Box>
            {details !== '' ? <Markdown text={details} /> : <Text dimColor>Nothing in this section.</Text>}
          </Box>
        )}
      </Box>
    )
  })
}
