// Writes a recap from a condensed transcript (hooks/digest.py's output).
// Shared by the Claude Code plugin and the session-recap CLI: each hands in
// its own `complete` (one model call) and its own note cache.

export const CHUNK_CHARS = 75_000

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

Be specific (names, numbers, files), not generic. Write in the language the person mostly writes in.`

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
export async function writeRecap({ digest, previous, complete, notes, progress = () => {} }) {
  const isUpdate = previous !== undefined && digest.from > 0
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
  const prompt = isUpdate
    ? `${meta}\n\nThe recap written after the first ${digest.from} prompts:\n\n<previous-recap>\n${previous.markdown}\n</previous-recap>\n\n` +
      `What happened since then (prompts ${digest.from + 1} to ${digest.prompts}):\n\n${material}\n\n` +
      `Rewrite the whole recap so it covers the session up to now. Keep what still holds from the previous recap, ` +
      `update what changed, move finished items out of Open threads.\n\n${RECAP_FORMAT}`
    : `${meta}\n\n${material}\n\n${RECAP_FORMAT}\nLater parts override earlier ones where the person changed course.`

  return complete({ stage: 'merge', system: MERGE_SYSTEM, prompt, maxTokens: 3000 })
}
