// Recap formats: what the final model call is asked to write. `recap` is the
// default and the only one with a map (the pane and viewer draw it); the others
// are plain Markdown for a purpose. To add one, add an entry here: a name, a
// one-line description, and the instructions. Keep them specific and short.

export const FORMATS = {
  standup: {
    description: 'A three-part standup note: done, next, blocked',
    instructions: `Write a standup note in Markdown with exactly these sections:

## Done
Bullets: what was finished in this session, concretely (features, fixes, files, PRs).

## Next
Bullets: the next two or three steps.

## Blocked
Bullets: what is waiting on someone or something; "nothing" if none.

Be brief: someone reads this in a meeting. Write in the language the person mostly writes in.`,
  },
  handoff: {
    description: 'A handoff for whoever (or whichever agent) continues the work',
    instructions: `Write a handoff in Markdown for someone who will continue this work without having seen the session:

## Goal
What the work is for, in two sentences.

## State
Where things stand: what works, what does not, what was verified and how.

## How to continue
Numbered steps, with the files, commands and decisions they need.

## Watch out for
Pitfalls found in the session: wrong turns, flaky things, constraints.

Be specific (names, paths, commands). Write in the language the person mostly writes in.`,
  },
  pr: {
    description: 'A pull request description for the changes the session made',
    instructions: `Write a pull request description in Markdown:

## What
One paragraph: what changes, from the reviewer's point of view.

## Why
The reason, and alternatives that were considered.

## How it was tested
Bullets: what was run or checked, as the session shows it. Do not claim tests the session did not run.

## Notes for the reviewer
Bullets: risky parts, follow-ups, anything left out on purpose.

Write in English unless the session is entirely in another language.`,
  },
}

export const FORMAT_NAMES = ['recap', ...Object.keys(FORMATS)]
