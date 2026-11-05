// The recap's five sections, found by their headings: shared by the Claude
// Code pane and the local viewer. A model that translates a heading is still
// matched, by its words or by its position.

export const SECTIONS = [
  { key: 'intent', label: 'Intent', match: /intent|意图|目标/i },
  { key: 'ideas', label: 'Decisions', match: /idea|decision|决策|想法|思路/i },
  { key: 'changed', label: 'Changes', match: /chang|变更|改动|产出|成果/i },
  { key: 'open', label: 'Open threads', match: /open|thread|未完成|待办|遗留/i },
  { key: 'resume', label: 'Resume', match: /resume|继续|下一步|接着/i },
]

export function sectionsOf(markdown) {
  const out = {}
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
