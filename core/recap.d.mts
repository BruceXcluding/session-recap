export type Digest = {
  agent: string
  title?: string
  cwd?: string
  branch?: string
  firstTs?: string
  lastTs?: string
  prompts: number
  from: number
  files: string[]
  fileCount: number
  text: string
}

export type Progress = { step: string; done: number; total: number }

export type CompleteRequest = {
  stage: 'part' | 'merge'
  system: string
  prompt: string
  maxTokens: number
}

export type NoteCache = {
  get(key: string): Promise<string | undefined> | string | undefined
  set(key: string, note: string): Promise<void> | void
}

export declare const CHUNK_CHARS: number
export declare const RECAP_FORMAT: string
export declare const CHUNK_SYSTEM: string
export declare const MERGE_SYSTEM: string
export declare function splitParts(text: string, size?: number): string[]
export declare function header(d: Digest): string
export declare function sha256(text: string): Promise<string>
export declare function writeRecap(args: {
  digest: Digest
  previous?: { markdown: string }
  complete: (request: CompleteRequest) => Promise<string>
  notes?: NoteCache
  progress?: (p: Progress) => void | Promise<void>
}): Promise<string>
