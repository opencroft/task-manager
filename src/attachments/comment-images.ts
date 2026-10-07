// An image pasted into a comment is stored as one of the task's attachments
// and referenced from the body as `![name](attachment:<id>)`. The host's
// markdown cannot resolve such a source, so a body is split at those
// references: the text between them renders as markdown, and each reference
// as the attachment's image. A reference inside a fenced code block is text.

export type CommentPart = { kind: 'text'; text: string } | { kind: 'image'; id: string; name: string }

/** The markdown that shows attachment `id` in a comment. */
export function attachmentImageMarkdown(id: string, name: string): string {
  return `![${name.replace(/[[\]\n]/g, ' ')}](attachment:${id})`
}

const REFERENCE = /!\[([^\]\n]*)\]\(attachment:([0-9a-f-]{36})\)/gi
const FENCE = /^\s{0,3}(```|~~~)/

function splitText(text: string, parts: CommentPart[]): void {
  let at = 0
  for (const match of text.matchAll(REFERENCE)) {
    parts.push({ kind: 'text', text: text.slice(at, match.index) })
    parts.push({ kind: 'image', id: (match[2] as string).toLowerCase(), name: match[1] ?? '' })
    at = match.index + match[0].length
  }
  parts.push({ kind: 'text', text: text.slice(at) })
}

/** `body` as text and image parts, in order; empty text between them is dropped. */
export function commentParts(body: string): CommentPart[] {
  const parts: CommentPart[] = []
  let outside: string[] = []
  let fence: string | null = null
  for (const line of body.split('\n')) {
    const marker = FENCE.exec(line)?.[1] ?? null
    if (fence === null && marker) {
      splitText(outside.join('\n'), parts)
      outside = [line]
      fence = marker
      continue
    }
    outside.push(line)
    if (fence !== null && marker === fence) {
      parts.push({ kind: 'text', text: outside.join('\n') })
      outside = []
      fence = null
    }
  }
  if (fence === null) {
    splitText(outside.join('\n'), parts)
  } else {
    parts.push({ kind: 'text', text: outside.join('\n') })
  }
  // Adjacent text parts join back into one, so markdown between them is not cut apart.
  const merged: CommentPart[] = []
  for (const part of parts) {
    const last = merged.at(-1)
    if (part.kind === 'text' && last?.kind === 'text') {
      last.text = `${last.text}\n${part.text}`
    } else {
      merged.push(part.kind === 'text' ? { ...part } : part)
    }
  }
  return merged.filter((part) => part.kind === 'image' || part.text.trim() !== '')
}
