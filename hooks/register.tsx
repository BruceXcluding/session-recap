import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Job, ProjectRow, Recap, SessionRow, View } from '../types'

const PANE = 'session-recap'
const TITLE = 'Session recap'
const CHUNK_CHARS = 75_000
const SESSIONS_SHOWN = 40

const view = atom(
  { plugin: 'session-recap', key: 'view' } as const,
  { screen: 'projects', projects: [], sessions: [] },
  { shape: 'view-2' },
)
const jobs = atom({ plugin: 'session-recap', key: 'jobs' } as const, {}, {
  shape: 'jobs-2',
})

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
  const line = text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()

  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

// A file's mtime is whole milliseconds from Python and may be fractional from
// $.fs.stat, so versions compare within a second.
function isSameVersion(a: { size: number; mtimeMs: number }, b: { size: number; mtimeMs: number }): boolean {
  return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1000
}

function errorText(err: unknown): string {
  return String(err).replace(/^Error: /, '')
}

type Digest = {
  title?: string
  cwd?: string
  branch?: string
  firstTs?: string
  lastTs?: string
  prompts: number
  files: string[]
  fileCount: number
  text: string
}

const RECAP_FORMAT = `Write the recap in Markdown with exactly these sections:

## Intent
One or two sentences: what the person was ultimately trying to achieve.

## Key ideas and decisions
Bullets. Each: the decision or insight, and why it was chosen (the reason, the alternative rejected).

## What changed
Bullets: concrete outputs (files, features, documents, commits, PRs, artifacts). Say "nothing yet" if none.

## Open threads
Bullets: unfinished work, unverified claims, unanswered questions, known problems.

## Where to resume
One or two sentences: the most sensible next step if the person picked this up today.

Be specific (names, numbers, files), not generic. Write in the language the person mostly writes in.`

const CHUNK_SYSTEM =
  'You condense one part of a long working session between a person and Claude (an AI coding assistant) into notes another model will merge. ' +
  'Lines tagged [USER] are the person, [CLAUDE] the assistant, "·" lines are tool calls. Keep facts, never invent.'

const MERGE_SYSTEM =
  'You write a recap of a working session between a person and Claude (an AI coding assistant) so the person can remember it quickly. ' +
  'Lines tagged [USER] are the person, [CLAUDE] the assistant, "·" lines are tool calls. Never invent facts.'

async function python(
  $: EngineInterface,
  args: string[],
): Promise<unknown> {
  const script = `${$.plugin.root}/hooks/digest.py`
  let lastError = ''
  for (const exe of ['python3', '/usr/bin/python3']) {
    try {
      const r = await $.process.run([exe, '-I', script, ...args], {
        timeoutMs: 120_000,
      })
      if (r.exitCode === 0) return JSON.parse(r.stdout)
      lastError = r.stderr.trim().split('\n').at(-1) ?? `exit ${r.exitCode}`
    } catch (err) {
      lastError = String(err)
    }
  }
  throw new Error(`digest.py failed: ${lastError}`)
}

async function projectsRoot($: EngineInterface): Promise<string> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')

  return `${config ?? `${home}/.claude`}/projects`
}

async function stored($: EngineInterface, id: string): Promise<Recap | undefined> {
  return (await $.store.get(`recap:${id}`)) as Recap | undefined
}

async function withRecapMarks(
  $: EngineInterface,
  rows: SessionRow[],
): Promise<SessionRow[]> {
  return Promise.all(
    rows.map(async row => {
      const recap = await stored($, row.id)
      if (recap === undefined) return row
      const intent = oneLine(sectionsOf(recap.markdown).intent, 160)

      return { ...row, recap: isSameVersion(recap, row) ? 'fresh' : 'stale', intent } as SessionRow
    }),
  )
}

async function showProjects($: EngineInterface): Promise<void> {
  try {
    const projects = (await python($, ['projects', await projectsRoot($)])) as ProjectRow[]
    await update($, view, v => ({ ...v, screen: 'projects' as const, projects, error: undefined }))
  } catch (err) {
    await update($, view, v => ({ ...v, screen: 'projects' as const, error: errorText(err) }))
  }
}

async function showSessions($: EngineInterface, project: ProjectRow): Promise<void> {
  try {
    const rows = (await python($, ['sessions', project.dir])) as SessionRow[]
    const sessions = await withRecapMarks($, rows.slice(0, SESSIONS_SHOWN))
    await update($, view, v => ({
      ...v,
      screen: 'sessions' as const,
      project,
      sessions,
      error: undefined,
    }))
  } catch (err) {
    await update($, view, v => ({ ...v, screen: 'sessions' as const, project, error: errorText(err) }))
  }
}

async function showRecap($: EngineInterface, session: SessionRow): Promise<void> {
  const recap = await stored($, session.id)
  await update($, view, v => ({
    ...v,
    screen: 'recap' as const,
    session,
    recap,
    section: 'all' as const,
    error: undefined,
  }))
}

function chunks(text: string): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > CHUNK_CHARS) {
    // Cut at a prompt boundary so a turn is not split across chunks.
    let cut = rest.lastIndexOf('\n[USER ', CHUNK_CHARS)
    if (cut < CHUNK_CHARS / 2) cut = CHUNK_CHARS
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  out.push(rest)

  return out
}

function header(d: Digest): string {
  const lines = [
    `Session title: ${d.title ?? '(none)'}`,
    `Working directory: ${d.cwd ?? '?'}${d.branch ? ` (branch ${d.branch})` : ''}`,
    `Time span: ${d.firstTs ?? '?'} to ${d.lastTs ?? '?'}, ${d.prompts} prompts from the person`,
  ]
  if (d.fileCount > 0) {
    lines.push(`Files edited (${d.fileCount}, newest last): ${d.files.join(', ')}`)
  }

  return lines.join('\n')
}

async function complete(
  $: EngineInterface,
  model: string,
  system: string,
  prompt: string,
  maxTokens: number,
): Promise<string> {
  const r = await $.model.complete({ model, system, prompt, maxTokens, timeoutMs: 300_000 })
  if (!r.isAnswered) {
    const why = r.reason === 'api-error' ? `api-error ${r.status ?? ''}` : r.reason
    throw new Error(`${model} gave no answer (${why})`)
  }

  return r.text
}

async function setJob($: EngineInterface, id: string, job: Job | undefined): Promise<void> {
  await update($, jobs, all => {
    const next = { ...all }
    if (job === undefined) delete next[id]
    else next[id] = job

    return next
  })
}

async function summarize($: EngineInterface, session: SessionRow): Promise<void> {
  if ((await read($, jobs))[session.id] !== undefined) return
  try {
    await setJob($, session.id, { step: 'Reading the transcript', done: 0, total: 0 })
    await update($, view, v => (v.session?.id === session.id ? { ...v, error: undefined } : v))
    // The session's own model: the one the person's provider surely serves.
    const model = await $.session.model()
    const before = await $.fs.stat(session.path)
    const d = (await python($, ['digest', session.path])) as Digest
    const meta = header(d)
    const parts = chunks(d.text)
    let body: string
    if (parts.length === 1) {
      await setJob($, session.id, { step: `Writing the recap with ${model}`, done: 0, total: 1 })
      body = `${meta}\n\n<transcript>\n${d.text}\n</transcript>`
    } else {
      let done = 0
      const total = parts.length + 1
      await setJob($, session.id, { step: `Condensing ${parts.length} parts with ${model}`, done: 0, total })
      const notes = await Promise.all(
        parts.map(async (part, i) => {
          const note = await complete(
            $,
            model,
            CHUNK_SYSTEM,
            `${meta}\n\nThis is part ${i + 1} of ${parts.length}.\n\n<transcript-part>\n${part}\n</transcript-part>\n\n` +
              'Write terse bullet notes on this part: what the person asked for and why, ideas and decisions with their reasons, ' +
              'what was built or changed, problems hit, and anything left unresolved at the end of the part. ' +
              'Keep names, numbers and file paths. Write in the language the person writes in.',
            2500,
          )
          done += 1
          await setJob($, session.id, {
            step: `Condensed ${done} of ${parts.length} parts`,
            done,
            total,
          })

          return `### Part ${i + 1} of ${parts.length}\n${note}`
        }),
      )
      await setJob($, session.id, { step: `Writing the recap with ${model}`, done: parts.length, total })
      body = `${meta}\n\nNotes on the session, part by part in time order:\n\n${notes.join('\n\n')}`
    }
    const markdown = await complete(
      $,
      model,
      MERGE_SYSTEM,
      `${body}\n\n${RECAP_FORMAT}\nLater parts override earlier ones where the person changed course.`,
      3000,
    )
    const recap: Recap = { size: before.size, mtimeMs: before.mtimeMs, at: Date.now(), markdown }
    await $.store.set(`recap:${session.id}`, recap)
    await update($, view, v => {
      const intent = oneLine(sectionsOf(markdown).intent, 160)
      const sessions = v.sessions.map(s =>
        s.id === session.id ? { ...s, recap: 'fresh' as const, intent } : s,
      )
      return v.session?.id === session.id
        ? { ...v, sessions, recap, error: undefined }
        : { ...v, sessions }
    })
    await setJob($, session.id, undefined)
    $.ui.toast(`Recap ready: ${session.title.slice(0, 60)}`)
  } catch (err) {
    await setJob($, session.id, undefined)
    await update($, view, v =>
      v.session?.id === session.id ? { ...v, error: errorText(err) } : v,
    )
  }
}

async function currentSession($: EngineInterface): Promise<SessionRow | undefined> {
  const id = await $.session.id()
  const projects = (await python($, ['projects', await projectsRoot($)])) as ProjectRow[]
  for (const project of projects) {
    const path = `${project.dir}/${id}.jsonl`
    if (!(await $.fs.exists(path))) continue
    const rows = (await python($, ['sessions', project.dir])) as SessionRow[]
    const sessions = await withRecapMarks($, rows.slice(0, SESSIONS_SHOWN))
    await update($, view, v => ({ ...v, projects, project, sessions }))

    return sessions.find(s => s.id === id)
  }

  return undefined
}

function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000)
  if (min < 60) return `${min}m ago`
  if (min < 48 * 60) return `${Math.round(min / 60)}h ago`

  return `${Math.round(min / 1440)}d ago`
}

function megabytes(n: number): string {
  return n < 1_000_000 ? `${Math.max(1, Math.round(n / 1000))} KB` : `${(n / 1_000_000).toFixed(1)} MB`
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

type Found =
  | { kind: 'project'; project: ProjectRow }
  | { kind: 'session'; project: ProjectRow; session: SessionRow }

// A project whose folder name holds the query wins; else a session whose
// title does, newest project first.
async function findByName($: EngineInterface, query: string): Promise<Found | undefined> {
  const q = query.toLowerCase()
  const projects = (await python($, ['projects', await projectsRoot($)])) as ProjectRow[]
  await update($, view, v => ({ ...v, projects }))
  const project =
    projects.find(p => baseName(p.cwd).toLowerCase() === q) ??
    projects.find(p => baseName(p.cwd).toLowerCase().includes(q))
  if (project !== undefined) return { kind: 'project', project }
  for (const p of projects) {
    const rows = (await python($, ['sessions', p.dir])) as SessionRow[]
    const hit = rows.find(s => s.title.toLowerCase().includes(q))
    if (hit === undefined) continue
    const sessions = await withRecapMarks($, rows.slice(0, SESSIONS_SHOWN))
    await update($, view, v => ({ ...v, project: p, sessions }))
    const [session] = await withRecapMarks($, [hit])

    return { kind: 'session', project: p, session: session ?? hit }
  }

  return undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-recap',
      description:
        'Recap this session; "/session-recap browse" lists every project, "/session-recap <name>" opens a project or session by name',
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
      if (found.session.recap !== 'fresh') void summarize($, found.session)
      return { text: `Writing a recap of "${found.session.title.slice(0, 60)}".` }
    }
    const session = await currentSession($)
    if (session === undefined) {
      await showProjects($)
      return { text: 'This session has no saved transcript yet; showing all projects.' }
    }
    await showRecap($, session)
    if (session.recap !== 'fresh') void summarize($, session)

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
          <Text color="error" weight="semibold">Something went wrong</Text>
          <Text color="error">{v.error}</Text>
          {onRetry !== undefined && (
            <Button key="retry" onPress={onRetry}>
              Try again
            </Button>
          )}
        </Box>
      )

    if (v.screen === 'projects') {
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text size="heading" weight="bold">Projects</Text>
            <Text dimColor size="footnote">Pick a project to see its sessions, newest first.</Text>
          </Box>
          {errorCard()}
          {v.projects.length === 0 && v.error === undefined && <Text dimColor>Loading projects…</Text>}
          <Box flexDirection="column" gap="sm">
            {v.projects.map(p => (
              <Box flexDirection="column">
                <Button key={p.dir} plain onPress={() => void showSessions($, p)}>
                  <Text weight="semibold">{baseName(p.cwd)}</Text>
                  {'  '}
                  <Text dimColor>
                    {p.sessions} {p.sessions === 1 ? 'session' : 'sessions'} · {ago(p.mtimeMs)}
                  </Text>
                </Button>
                <Text dimColor size="footnote">{p.cwd}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    if (v.screen === 'sessions') {
      const recapped = v.sessions.filter(s => s.recap !== undefined).length

      return (
        <Box flexDirection="column" gap={1}>
          <Button key="to-projects" plain dimColor onPress={() => void showProjects($)}>
            ‹ All projects
          </Button>
          <Box flexDirection="column">
            <Text size="heading" weight="bold">{baseName(v.project?.cwd ?? '')}</Text>
            <Text dimColor size="footnote">
              {v.sessions.length} sessions · {recapped} recapped
            </Text>
          </Box>
          {errorCard()}
          <Box flexDirection="column" gap="sm">
            {v.sessions.map(s => {
              const job = running[s.id]
              const mark =
                s.recap === 'fresh' ? <Text color="success">●</Text>
                : s.recap === 'stale' ? <Text color="warning">◐</Text>
                : <Text dimColor>○</Text>

              return (
                <Box flexDirection="column">
                  <Button key={s.id} plain onPress={() => void showRecap($, s)}>
                    {mark} <Text weight="semibold">{s.title.slice(0, Math.max(20, width - 24))}</Text>
                    {'  '}
                    <Text dimColor>
                      {ago(s.mtimeMs)} · {megabytes(s.size)}
                    </Text>
                  </Button>
                  {job !== undefined ? (
                    <Text color="warning" size="footnote">  {progress(job)}</Text>
                  ) : s.intent !== undefined ? (
                    <Text dimColor size="footnote">  {s.intent}</Text>
                  ) : null}
                </Box>
              )
            })}
          </Box>
          <Text dimColor size="caption">● recap ready  ◐ session changed since  ○ no recap yet</Text>
        </Box>
      )
    }

    const s = v.session
    if (s === undefined) return <Text dimColor>No session picked.</Text>
    const job = running[s.id]
    const recap = v.recap
    const isStale = recap !== undefined && !isSameVersion(recap, s)
    const parts = recap !== undefined ? sectionsOf(recap.markdown) : {}
    const isStructured = parts.intent !== undefined
    const section = v.section ?? 'all'
    const detailKeys: SectionKey[] = section === 'all' ? ['ideas', 'changed', 'open'] : [section]
    const details = SECTIONS.filter(x => detailKeys.includes(x.key) && parts[x.key] !== undefined)
      .map(x => (section === 'all' ? `### ${x.label}\n\n${parts[x.key]}` : (parts[x.key] ?? '')))
      .join('\n\n')
    const pick = (next: NonNullable<View['section']>) => () =>
      void update($, view, w => ({ ...w, section: next }))
    const write = () => void summarize($, s)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap="sm">
          <Button key="to-sessions" plain dimColor onPress={() => void (v.project ? showSessions($, v.project) : showProjects($))}>
            ‹ Sessions
          </Button>
          {recap !== undefined && (
            <Box flexDirection="row" gap="sm">
              <Button key="copy" onPress={pressed => void $.ui.copy({ text: recap.markdown, surface: pressed.surface })}>
                Copy
              </Button>
              {job === undefined && (
                <Button key="summarize" variant={isStale ? 'primary' : 'secondary'} onPress={write}>
                  Refresh recap
                </Button>
              )}
            </Box>
          )}
        </Box>

        <Box flexDirection="column">
          <Text size="title" weight="bold">{s.title}</Text>
          <Text dimColor size="footnote">
            {baseName(v.project?.cwd ?? '')} · {megabytes(s.size)} · active {ago(s.mtimeMs)}
            {recap ? ` · recap from ${ago(recap.at)}` : ''}
          </Text>
        </Box>

        {job !== undefined && (
          <Box flexDirection="column" gap="xs" borderStyle="round" borderColor="warning" paddingX={1}>
            <Text color="warning" weight="semibold">Writing the recap</Text>
            <Text>{progress(job)}</Text>
          </Box>
        )}
        {errorCard(job === undefined ? write : undefined)}
        {isStale && job === undefined && (
          <Text color="warning" size="footnote">
            The session has continued since this recap. Refresh to include the newer part.
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
              <Text color="claude" size="caption" weight="bold">INTENT</Text>
              <Markdown text={parts.intent ?? ''} />
            </Box>
            {parts.resume !== undefined && (
              <Box flexDirection="column" gap="xs" borderStyle="round" borderColor="success" paddingX={1}>
                <Text color="success" size="caption" weight="bold">WHERE TO RESUME</Text>
                <Markdown text={parts.resume} />
              </Box>
            )}
            <Box flexDirection="row" gap="sm" flexWrap="wrap">
              {(['all', 'ideas', 'changed', 'open'] as const).map(key => (
                <Button
                  key={`tab-${key}`}
                  variant={section === key ? 'primary' : 'secondary'}
                  onPress={pick(key)}
                >
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
