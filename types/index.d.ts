// One project folder, with its sessions from every agent.
export type ProjectRow = {
  cwd: string
  sessions: number
  mtimeMs: number
  // Sessions per agent: claude, codex, dsh, opencode.
  agents: Record<string, number>
}

export type SessionRow = {
  agent: string
  id: string
  path: string
  cwd: string
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
  // The model that wrote it.
  model?: string
  // How many prompts the recap covers: a refresh recaps only the ones after.
  prompts?: number
}

export type View = {
  screen: 'projects' | 'sessions' | 'recap'
  projects: ProjectRow[]
  project?: ProjectRow
  sessions: SessionRow[]
  // Which agent's sessions the list shows; absent, all of them.
  agent?: string
  session?: SessionRow
  recap?: Recap
  // Which part of the recap is shown below the intent and resume cards.
  section?: 'all' | 'ideas' | 'changed' | 'open'
  error?: string
  // The person's choices, kept in the plugin's store across sessions.
  prefs?: Prefs
  // Where this session runs and with which model, for the Projects screen.
  here?: { cwd: string; home: string; model: string }
  // Whether the settings card and the temporary folders are open.
  isSettingsOpen?: boolean
  isTempOpen?: boolean
}

export type Prefs = {
  // The recap's model; '' is the session's own.
  model: string
  // The model condensing parts of long sessions; '' is the recap's model.
  partModel: string
  // 'agent': this IDE's sessions only; 'all': every agent's.
  scope: 'agent' | 'all'
}

export type Job = { step: string; done: number; total: number }

declare module 'claude-code' {
  interface PluginState {
    'session-recap': {
      view: Shaped<View>
      // Progress per session key (agent:id) while a recap is being written.
      jobs: Shaped<Record<string, Job>>
    }
  }
}
