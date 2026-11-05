export type ProjectRow = {
  dir: string
  cwd: string
  sessions: number
  mtimeMs: number
}

export type SessionRow = {
  id: string
  path: string
  title: string
  size: number
  mtimeMs: number
  // Whether a recap is stored, and whether the session changed since.
  recap?: 'fresh' | 'stale'
  // The stored recap's intent, one line, shown under the title.
  intent?: string
}

export type Recap = {
  size: number
  mtimeMs: number
  at: number
  markdown: string
}

export type View = {
  screen: 'projects' | 'sessions' | 'recap'
  projects: ProjectRow[]
  project?: ProjectRow
  sessions: SessionRow[]
  session?: SessionRow
  recap?: Recap
  // Which part of the recap is shown below the intent and resume cards.
  section?: 'all' | 'ideas' | 'changed' | 'open'
  error?: string
}

export type Job = { step: string; done: number; total: number }

declare module 'claude-code' {
  interface PluginState {
    'session-recap': {
      view: Shaped<View>
      // Progress per session id while a recap is being written.
      jobs: Shaped<Record<string, Job>>
    }
  }
}
