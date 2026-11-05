import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { writeRecap } from '../core/recap.mjs'
import type { Digest } from '../core/recap.mjs'
import type { Job, Prefs, ProjectRow, Recap, SessionRow, Tick, View } from '../types'

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
const AGENT_COLOR: Record<string, string> = {
  claude: 'claude',
  codex: 'suggestion',
  dsh: 'ide',
  opencode: 'merged',
}
// The IDE this plugin runs in: the sessions it shows unless asked for all.
const HOME_AGENT = 'claude'

// Model aliases the session's client resolves (to the provider's own ids
// where the person maps them, as ANTHROPIC_DEFAULT_*_MODEL does).
const MODEL_CHOICES = ['haiku', 'sonnet', 'opus']
const DEFAULT_PREFS: Prefs = { model: '', partModel: '', scope: 'agent' }

// Folders an app or a test made for a moment: listed apart, folded.
function isTemporary(cwd: string): boolean {
  return /\/scratch-workspaces\/|^\/(private\/)?tmp(\/|$)|^\/(private\/)?var\/folders\//.test(cwd)
}

const view = atom(
  { plugin: 'session-recap', key: 'view' } as const,
  { screen: 'projects', projects: [], sessions: [] },
  { shape: 'view-4' },
)
const jobs = atom(
  { plugin: 'session-recap', key: 'jobs' } as const,
  {},
  {
    shape: 'jobs-4',
  },
)

const tick = atom({ plugin: 'session-recap', key: 'tick' } as const, { frame: 0, now: 0 } as Tick, {
  shape: 'tick-1',
})
// Frames per second of the progress animation, while a recap is being written.
const FRAME_MS = 200
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
// The one timer that advances `tick`; a reload drops it with the module.
let ticker: Timer | undefined

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

async function loadPrefs($: EngineInterface, options: { model: string; partModel: string }): Promise<Prefs> {
  const saved = (await $.store.get('prefs')) as Partial<Prefs> | undefined

  return {
    ...DEFAULT_PREFS,
    model: options.model,
    partModel: options.partModel,
    ...saved,
  }
}

async function setPrefs($: EngineInterface, change: Partial<Prefs>): Promise<void> {
  const next = await update($, view, v => ({ ...v, prefs: { ...DEFAULT_PREFS, ...v.prefs, ...change } }))
  await $.store.set('prefs', next.prefs)
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
      agent:
        v.project?.cwd === project.cwd
          ? v.agent
          : (v.prefs ?? DEFAULT_PREFS).scope === 'agent' && rows.some(r => r.agent === HOME_AGENT)
            ? HOME_AGENT
            : undefined,
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
  const now = await $.clock.now()
  const all = await update($, jobs, all => {
    const next = { ...all }
    if (job === undefined) delete next[key]
    else next[key] = { ...job, startedAt: all[key]?.startedAt ?? now }

    return next
  })
  // Animate while anything runs; stop the timer when the last job ends.
  if (Object.keys(all).length > 0 && ticker === undefined) {
    await update($, tick, t => ({ ...t, now }))
    ticker = $.clock.every(FRAME_MS, () => {
      void (async () => {
        const at = await $.clock.now()
        await update($, tick, t => ({ frame: t.frame + 1, now: at }))
      })()
    })
  } else if (Object.keys(all).length === 0 && ticker !== undefined) {
    ticker.cancel()
    ticker = undefined
  }
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))

  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
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

async function summarize($: EngineInterface, session: SessionRow): Promise<void> {
  const key = keyOf(session)
  if ((await read($, jobs))[key] !== undefined) return
  try {
    await setJob($, key, { step: 'Reading the transcript', done: 0, total: 0 })
    await update($, view, v => (v.session && keyOf(v.session) === key ? { ...v, error: undefined } : v))
    // The chosen model, else the session's own: the one its provider surely serves.
    const prefs = (await read($, view)).prefs ?? DEFAULT_PREFS
    const model = prefs.model !== '' ? prefs.model : await $.session.model()
    const partModel = prefs.partModel
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
      model,
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

// `~/…` for the home folder, and a long path cut in its middle to fit.
function shortPath(path: string, home: string, max: number): string {
  const p = home !== '' && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
  if (p.length <= max) return p
  const keep = Math.max(8, max - 1)

  return `${p.slice(0, Math.ceil(keep * 0.4))}…${p.slice(p.length - Math.floor(keep * 0.6))}`
}

function modelName(prefs: Prefs | undefined, here: View['here']): string {
  const chosen = prefs?.model ?? ''

  return chosen !== '' ? chosen : `the session's model${here?.model ? ` (${here.model})` : ''}`
}

const DAY = 24 * 60 * 60 * 1000
function period(ms: number): 'Today' | 'This week' | 'Earlier' {
  const age = Date.now() - ms

  return age < DAY ? 'Today' : age < 7 * DAY ? 'This week' : 'Earlier'
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
  const configured = {
    model: typeof options.model === 'string' ? options.model.trim() : '',
    partModel: typeof options.partModel === 'string' ? options.partModel.trim() : '',
  }

  on('session.start', async ($, e, next) => {
    // The person's choices and where this session runs. A host that cannot
    // say leaves them at their defaults; the command registers either way.
    try {
      const prefs = await loadPrefs($, configured)
      const here = {
        cwd: await $.session.root(),
        home: (await $.env.get('HOME')) ?? '',
        model: await $.session.model(),
      }
      await update($, view, v => ({ ...v, prefs, here }))
    } catch (err) {
      $.ui.log(`session-recap: settings not loaded: ${errorText(err)}`, { to: 'debug' })
    }
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

    // Only a drawing that shows a running job reads the tick, so only those redraw with it.
    const frame = Object.keys(running).length > 0 ? await read($, tick) : { frame: 0, now: 0 }

    // A spinner, the bar filled to the steps done with a light sweeping the rest
    // (so a long step still moves), the step, and the time so far.
    const progress = (job: Job, cells = 12) => {
      const filled = job.total > 0 ? Math.min(cells, Math.round((job.done / job.total) * cells)) : 0
      const empty = cells - filled
      const sweep = empty > 0 ? frame.frame % (empty + 3) : -1
      const rest = Array.from({ length: empty }, (_, i) => (i === sweep || i === sweep - 1 ? '▰' : '▱')).join('')
      const time = job.startedAt !== undefined && frame.now > 0 ? ` · ${elapsed(frame.now - job.startedAt)}` : ''

      return (
        <Text>
          <Text color="warning">{SPINNER[frame.frame % SPINNER.length]} </Text>
          {job.total > 0 && <Text color="warning">{'▰'.repeat(filled)}</Text>}
          {job.total > 0 && <Text dimColor>{rest} </Text>}
          <Text> {job.step}…</Text>
          <Text dimColor>{time}</Text>
        </Text>
      )
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

    const prefs = v.prefs ?? DEFAULT_PREFS
    const home = v.here?.home ?? ''

    const agentChips = (agents: Record<string, number>) =>
      Object.entries(agents).map(([agent, n], i) => (
        <Text color={AGENT_COLOR[agent] ?? 'subtle'}>
          {i > 0 ? '  ' : ''}● {AGENT_LABEL[agent] ?? agent} {n}
        </Text>
      ))

    const choice = (key: string, label: string, isOn: boolean, onPress: () => void) => (
      <Button key={key} variant={isOn ? 'primary' : 'secondary'} onPress={onPress}>
        {label}
      </Button>
    )

    // The recap and part models, chosen here and kept across sessions.
    const settingsCard = v.isSettingsOpen === true && (
      <Box flexDirection="column" gap="sm" borderStyle="round" borderColor="subtle" paddingX={1} paddingY="sm">
        <Text weight="semibold">Recap model</Text>
        <Box flexDirection="row" gap="sm" flexWrap="wrap">
          {choice(
            'model-session',
            `Session model${v.here?.model ? ` · ${v.here.model}` : ''}`,
            prefs.model === '',
            () => void setPrefs($, { model: '' }),
          )}
          {[...new Set([...MODEL_CHOICES, configured.model, prefs.model].filter(m => m !== ''))].map(m =>
            choice(`model-${m}`, m, prefs.model === m, () => void setPrefs($, { model: m })),
          )}
        </Box>
        <Text weight="semibold">Condense long sessions' parts with</Text>
        <Box flexDirection="row" gap="sm" flexWrap="wrap">
          {choice('part-same', 'Same as recap', prefs.partModel === '', () => void setPrefs($, { partModel: '' }))}
          {[...new Set([...MODEL_CHOICES, configured.partModel, prefs.partModel].filter(m => m !== ''))].map(m =>
            choice(`part-${m}`, m, prefs.partModel === m, () => void setPrefs($, { partModel: m })),
          )}
        </Box>
        <Text dimColor size="footnote">
          Aliases resolve through this session's provider settings. Another model id: set "Recap model" in the plugin's
          settings. A cheaper part model saves the most on long sessions.
        </Text>
      </Box>
    )

    const settingsButton = (
      <Button
        key="settings"
        variant={v.isSettingsOpen === true ? 'primary' : 'secondary'}
        onPress={() => void update($, view, w => ({ ...w, isSettingsOpen: w.isSettingsOpen !== true }))}
      >
        {`Model: ${prefs.model === '' ? 'session' : prefs.model}`}
      </Button>
    )

    if (v.screen === 'projects') {
      const inScope = (p: ProjectRow) => prefs.scope === 'all' || (p.agents[HOME_AGENT] ?? 0) > 0
      const scoped = v.projects.filter(inScope)
      const hidden = v.projects.length - scoped.length
      const current = scoped.find(p => p.cwd === v.here?.cwd)
      const rest = scoped.filter(p => p !== current)
      const lasting = rest.filter(p => !isTemporary(p.cwd))
      const temporary = rest.filter(p => isTemporary(p.cwd))
      const counts = (p: ProjectRow) => (prefs.scope === 'all' ? p.agents : { [HOME_AGENT]: p.agents[HOME_AGENT] ?? 0 })
      const others = (p: ProjectRow) =>
        prefs.scope === 'agent'
          ? Object.entries(p.agents)
              .filter(([a]) => a !== HOME_AGENT)
              .map(([a, n]) => `${AGENT_LABEL[a] ?? a} ${n}`)
              .join(' · ')
          : ''
      const sessionCount = (p: ProjectRow) => Object.values(counts(p)).reduce((a, b) => a + b, 0)

      const row = (p: ProjectRow) => {
        const n = sessionCount(p)
        const also = others(p)

        return (
          <Box flexDirection="column">
            <Button key={p.cwd} plain onPress={() => void showSessions($, p)}>
              <Text weight="semibold">{baseName(p.cwd)}</Text>
              {'  '}
              <Text dimColor>
                {n} {n === 1 ? 'session' : 'sessions'} · {ago(p.mtimeMs)}
              </Text>
            </Button>
            <Text size="footnote">
              {'  '}
              {agentChips(counts(p))}
              <Text dimColor>
                {also !== '' ? `  · also ${also}` : ''}
                {'  '}
                {shortPath(p.cwd, home, Math.max(24, width - 36))}
              </Text>
            </Text>
          </Box>
        )
      }

      const groups = (['Today', 'This week', 'Earlier'] as const)
        .map(name => ({ name, rows: lasting.filter(p => period(p.mtimeMs) === name) }))
        .filter(g => g.rows.length > 0)

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap="sm">
            <Text size="heading" weight="bold">
              Projects
            </Text>
            {settingsButton}
          </Box>
          <Box flexDirection="row" gap="sm" flexWrap="wrap">
            {choice(
              'scope-agent',
              `${AGENT_LABEL[HOME_AGENT]} sessions`,
              prefs.scope === 'agent',
              () => void setPrefs($, { scope: 'agent' }),
            )}
            {choice('scope-all', 'All agents', prefs.scope === 'all', () => void setPrefs($, { scope: 'all' }))}
          </Box>
          {settingsCard}
          {errorCard()}
          {v.projects.length === 0 && v.error === undefined && <Text dimColor>Loading projects…</Text>}

          {current !== undefined && (
            <Box flexDirection="column" gap="xs" borderStyle="round" borderColor="claude" paddingX={1}>
              <Text color="claude" size="caption" weight="bold">
                THIS PROJECT
              </Text>
              {row(current)}
            </Box>
          )}

          {groups.map(g => (
            <Box flexDirection="column" gap="sm">
              <Text dimColor size="caption" weight="bold">
                {g.name.toUpperCase()}
              </Text>
              {g.rows.map(row)}
            </Box>
          ))}

          {temporary.length > 0 && (
            <Box flexDirection="column" gap="sm">
              <Button
                key="temp"
                plain
                dimColor
                onPress={() => void update($, view, w => ({ ...w, isTempOpen: w.isTempOpen !== true }))}
              >
                {v.isTempOpen === true ? '▾' : '▸'} Temporary folders ({temporary.length})
              </Button>
              {v.isTempOpen === true && temporary.map(row)}
            </Box>
          )}

          {prefs.scope === 'agent' && hidden > 0 && (
            <Button key="show-all" plain dimColor onPress={() => void setPrefs($, { scope: 'all' })}>
              + {hidden} more {hidden === 1 ? 'project' : 'projects'} from Codex, dsh and OpenCode
            </Button>
          )}
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
                    <Text size="footnote"> {progress(job, 8)}</Text>
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
    const write = () => void summarize($, s)

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
          <Box flexDirection="row" gap="sm">
            {settingsButton}
            {recap !== undefined && (
              <Button
                key="copy"
                onPress={pressed => void $.ui.copy({ text: recap.markdown, surface: pressed.surface })}
              >
                Copy
              </Button>
            )}
            {recap !== undefined && job === undefined && (
              <Button key="summarize" variant={isStale ? 'primary' : 'secondary'} onPress={write}>
                {isStale ? 'Update recap' : 'Refresh recap'}
              </Button>
            )}
          </Box>
        </Box>
        {settingsCard}

        <Box flexDirection="column">
          <Text size="title" weight="bold">
            {s.title}
          </Text>
          <Text dimColor size="footnote">
            {AGENT_LABEL[s.agent] ?? s.agent} · {baseName(s.cwd)} · {megabytes(s.size)} · active {ago(s.mtimeMs)}
            {recap ? ` · recap from ${ago(recap.at)}${recap.model ? ` by ${recap.model}` : ''}` : ''}
          </Text>
        </Box>

        {job !== undefined && (
          <Box flexDirection="column" gap="xs" borderStyle="round" borderColor="warning" paddingX={1}>
            <Text color="warning" weight="semibold">
              Writing the recap
            </Text>
            {progress(job)}
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
              Reads the whole transcript and writes its intent, key decisions, changes, open threads and where to resume
              with {modelName(v.prefs, v.here)}, and costs some tokens.
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
