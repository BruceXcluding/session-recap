// Writes a recap from a condensed transcript (hooks/digest.py's output).
// Shared by the Claude Code plugin and the session-recap CLI: each hands in
// its own `complete` (one model call) and its own note cache.

export const CHUNK_CHARS = 75_000

import { FORMATS } from './formats.mjs'

// The map: the same recap as data, for the pane's Map view. It follows the
// Markdown in one fenced block, so a reader that does not know it sees prose.
const MAP_FENCE = 'json recap-map'
const MAP_SHAPE = `{
  "phases": [{ "title": "≤ 12 characters", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "summary": "one line", "pivot": false }],
  "decisions": [{ "chosen": "what was chosen", "rejected": ["alternatives turned down"], "why": "one line", "status": "done | open | paused" }],
  "shipped": ["concrete output"],
  "open": ["unfinished item"],
  "rejected": ["idea dropped, with a three-word reason"]
}`
const MAP_RULES =
  'Phases: 2 to 6, in time order, the stages the work went through; "pivot": true where the person changed direction. ' +
  "Dates from the transcript's timestamps. Decisions: the 3 to 8 that matter most. " +
  'Every string short (under 60 characters), in the same language as the recap.'
const MAP_FORMAT = `Then, after the Markdown, add one fenced block opened with \`\`\`${MAP_FENCE} holding JSON of this shape:

${MAP_SHAPE}

${MAP_RULES}`

export const RECAP_FORMAT = `Write the recap in Markdown with exactly these sections:

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

Be specific (names, numbers, files), not generic. Write in the language the person mostly writes in.

${MAP_FORMAT}`

const LEGEND =
  'Lines tagged [USER] are the person, [ASSISTANT] the AI agent\'s final reply of that turn, "·" lines are commits, pushes and PRs.'

export const CHUNK_SYSTEM =
  'You condense one part of a long working session between a person and an AI coding agent into notes another model will merge. ' +
  `${LEGEND} Keep facts, never invent.`

export const MERGE_SYSTEM =
  'You write a recap of a working session between a person and an AI coding agent so the person can remember it quickly. ' +
  `${LEGEND} Never invent facts.`

const PART_ASK =
  'Write terse bullet notes on this part: what the person asked for and why, ideas and decisions with their reasons, ' +
  'what was built or changed, problems hit, and anything left unresolved at the end of the part. ' +
  'Keep names, numbers and file paths. Write in the language the person writes in.'

export function splitParts(text, size = CHUNK_CHARS) {
  const out = []
  let rest = text
  while (rest.length > size) {
    // Cut at a prompt boundary so a turn is not split across parts.
    let cut = rest.lastIndexOf('\n[USER', size)
    if (cut < size / 2) cut = size
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) out.push(rest)

  return out
}

export function header(d) {
  const lines = [
    `Session title: ${d.title ?? '(none)'}`,
    `Agent: ${d.agent ?? '?'}`,
    `Working directory: ${d.cwd ?? '?'}${d.branch ? ` (branch ${d.branch})` : ''}`,
    `Time span: ${d.firstTs ?? '?'} to ${d.lastTs ?? '?'}, ${d.prompts} prompts from the person`,
  ]
  if (d.fileCount > 0) {
    lines.push(`Files edited (${d.fileCount}, newest last): ${d.files.join(', ')}`)
  }

  return lines.join('\n')
}

export async function sha256(text) {
  const bytes = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', bytes)

  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Writes the recap's Markdown.
 *
 * - `digest`: digest.py's output; with `digest.from > 0` it holds only the
 *   turns after the first `from` prompts, and `previous` is the recap of those.
 * - `complete({ stage, system, prompt, maxTokens })`: one model call, the text back.
 * - `notes`: `{ get(key), set(key, note) }`, a cache of part notes by content hash,
 *   so a part already condensed (a retried or repeated run) costs nothing.
 * - `progress({ step, done, total })`: called as the work moves.
 */
export async function writeRecap({ digest, previous, complete, notes, progress = () => {}, format = 'recap' }) {
  const instructions = formatText(format)
  // Only a recap is updated from an earlier one; another format is written whole.
  const isUpdate = format === 'recap' && previous !== undefined && digest.from > 0
  if (isUpdate && digest.text.trim() === '') return previous.markdown

  const meta = header(digest)
  const parts = splitParts(digest.text)
  const total = parts.length > 1 ? parts.length + 1 : 1
  let material
  if (parts.length <= 1) {
    material = `<transcript>\n${digest.text}\n</transcript>`
  } else {
    let done = 0
    await progress({ step: `Condensing ${parts.length} parts`, done: 0, total })
    const condensed = await Promise.all(
      parts.map(async (part, i) => {
        const key = await sha256(`${CHUNK_SYSTEM}\n${part}`)
        let note = await notes?.get(key)
        if (note === undefined) {
          note = await complete({
            stage: 'part',
            system: CHUNK_SYSTEM,
            prompt: `${meta}\n\nThis is part ${i + 1} of ${parts.length}.\n\n<transcript-part>\n${part}\n</transcript-part>\n\n${PART_ASK}`,
            maxTokens: 2500,
          })
          await notes?.set(key, note)
        }
        done += 1
        await progress({ step: `Condensed ${done} of ${parts.length} parts`, done, total })

        return `### Part ${i + 1} of ${parts.length}\n${note}`
      }),
    )
    material = `Notes on the session, part by part in time order:\n\n${condensed.join('\n\n')}`
  }

  await progress({ step: isUpdate ? 'Updating the recap' : 'Writing the recap', done: total - 1, total })
  const prompt = finalPrompt(meta, material, digest, isUpdate ? previous : undefined, instructions)

  return complete({ stage: 'merge', system: MERGE_SYSTEM, prompt, maxTokens: 5000 })
}

/** The instructions of a format; throws on a name no format has. */
export function formatText(format = 'recap') {
  if (format === 'recap') return RECAP_FORMAT
  const found = FORMATS[format]
  if (found === undefined)
    throw new Error(`no recap format "${format}"; one of: recap, ${Object.keys(FORMATS).join(', ')}`)
  return found.instructions
}

// The one request that writes (or updates) the recap from its material.
function finalPrompt(meta, material, digest, previous, instructions = RECAP_FORMAT) {
  return previous !== undefined
    ? `${meta}\n\nThe recap written after the first ${digest.from} prompts:\n\n<previous-recap>\n${previous.markdown}\n</previous-recap>\n\n` +
        `What happened since then (prompts ${digest.from} to ${digest.prompts}; prompt ${digest.from} is repeated to show how it ended):\n\n${material}\n\n` +
        `Rewrite the whole recap so it covers the session up to now. Keep what still holds from the previous recap, ` +
        `update what changed, move finished items out of Open threads.\n\n${instructions}`
    : `${meta}\n\n${material}\n\n${instructions}\nLater parts override earlier ones where the person changed course.`
}

/**
 * The recap as one request for a model someone else runs: the agent that
 * called an MCP tool writes it with its own model, so no key is needed here.
 * `digest` should be condensed small enough for one context (digest.py's
 * budget argument); `previous` makes it an update, as in writeRecap.
 */
export function recapRequest({ digest, previous, format = 'recap' }) {
  const instructions = formatText(format)
  const isUpdate = format === 'recap' && previous !== undefined && digest.from > 0
  const material = `<transcript>\n${digest.text}\n</transcript>`

  return {
    system: MERGE_SYSTEM,
    prompt: finalPrompt(header(digest), material, digest, isUpdate ? previous : undefined, instructions),
  }
}

/**
 * Splits a stored recap into its Markdown (what is shown and copied) and its
 * map, when it has one that parses. Strings are trimmed and lists capped, so
 * a drawing can trust the shape.
 */
export function splitRecap(raw) {
  const at = raw.lastIndexOf('```' + MAP_FENCE)
  if (at < 0) return { markdown: raw.trim(), map: undefined }
  const markdown = raw.slice(0, at).trim()
  const end = raw.indexOf('```', at + 3 + MAP_FENCE.length)
  const body = raw.slice(at + 3 + MAP_FENCE.length, end < 0 ? undefined : end)

  return { markdown, map: parseMap(body) }
}

const str = (v, max = 120) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined)
const strs = (v, n) =>
  Array.isArray(v)
    ? v
        .map(x => str(x))
        .filter(x => x !== undefined)
        .slice(0, n)
    : []

export function parseMap(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (data === null || typeof data !== 'object') return undefined
  const phases = (Array.isArray(data.phases) ? data.phases : [])
    .map(p => ({
      title: str(p?.title, 40),
      from: str(p?.from, 10),
      to: str(p?.to, 10),
      summary: str(p?.summary),
      pivot: p?.pivot === true,
    }))
    .filter(p => p.title !== undefined)
    .slice(0, 8)
  const decisions = (Array.isArray(data.decisions) ? data.decisions : [])
    .map(d => ({
      chosen: str(d?.chosen),
      rejected: strs(d?.rejected, 4),
      why: str(d?.why),
      status: ['done', 'open', 'paused'].includes(d?.status) ? d.status : 'done',
    }))
    .filter(d => d.chosen !== undefined)
    .slice(0, 10)
  const map = {
    phases,
    decisions,
    shipped: strs(data.shipped, 40),
    open: strs(data.open, 40),
    rejected: strs(data.rejected, 40),
  }
  const isEmpty = phases.length === 0 && decisions.length === 0 && map.shipped.length === 0 && map.open.length === 0

  return isEmpty ? undefined : map
}

export const MAP_SYSTEM =
  'You turn a recap of a working session into structured data for a timeline view. Use only what the recap says; never invent.'

/**
 * Builds the map of a recap written without one (before maps existed), from
 * its Markdown alone: one small call. Resolves the recap with the map block
 * appended, ready to store, or rejects when the reply holds no usable map.
 */
export async function addMap({ raw, digest, complete }) {
  const { markdown } = splitRecap(raw)
  const reply = await complete({
    stage: 'merge',
    system: MAP_SYSTEM,
    prompt:
      `${digest ? `${header(digest)}\n\n` : ''}<recap>\n${markdown}\n</recap>\n\n` +
      `Reply with only one fenced block opened with \`\`\`${MAP_FENCE} holding JSON of this shape:\n\n${MAP_SHAPE}\n\n${MAP_RULES} ` +
      'Where the recap gives no dates, leave "from" and "to" out.',
    maxTokens: 2000,
  })
  const { map } = splitRecap(`\n${reply}`)
  if (map === undefined) throw new Error('the model gave no usable map')

  return `${markdown}\n\n\`\`\`${MAP_FENCE}\n${JSON.stringify(map, null, 1)}\n\`\`\`\n`
}
