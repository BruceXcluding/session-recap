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
  // Secrets removed from the text before it reaches a model.
  redactions?: number
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
  // 'recap' (default) or a name in core/formats.mjs
  format?: string
}): Promise<string>

export type MapPhase = { title: string; from?: string; to?: string; summary?: string; pivot: boolean }
export type MapDecision = { chosen: string; rejected: string[]; why?: string; status: 'done' | 'open' | 'paused' }
export type RecapMap = {
  phases: MapPhase[]
  decisions: MapDecision[]
  shipped: string[]
  open: string[]
  rejected: string[]
}

export declare const MAP_SYSTEM: string
export declare function splitRecap(raw: string): { markdown: string; map: RecapMap | undefined }
export declare function parseMap(text: string): RecapMap | undefined
export declare function addMap(args: {
  raw: string
  digest?: Digest
  complete: (request: CompleteRequest) => Promise<string>
}): Promise<string>

export declare function formatText(format?: string): string
export declare function recapRequest(args: { digest: Digest; previous?: { markdown: string }; format?: string }): {
  system: string
  prompt: string
}
