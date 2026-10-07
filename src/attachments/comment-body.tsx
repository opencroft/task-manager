// A comment's body: markdown through the host's renderer, with each attachment
// image it references drawn in place. A reference to an attachment that is gone,
// or not an image, reads as its name.

import { Markdown } from '@opencroft/client'
import { ImageIcon } from 'lucide-react'

import type { TaskAttachment } from '../../shared/attachments'
import { commentParts } from './comment-images'

export interface CommentBodyProps {
  body: string
  attachment: (id: string) => TaskAttachment | undefined
  preview: (id: string) => string | null
}

export function CommentBody({ body, attachment, preview }: CommentBodyProps) {
  const parts = commentParts(body)
  if (parts.every((part) => part.kind === 'text')) {
    return <Markdown text={body} />
  }
  // A part's place in the body is its only identity: the same image may be referenced twice.
  return (
    <div className="flex flex-col gap-2">
      {parts.map((part, place) => {
        if (part.kind === 'text') {
          return <Markdown key={place} text={part.text} />
        }
        const stored = attachment(part.id)
        const name = part.name || stored?.name || 'image'
        if (!stored?.previewable) {
          return (
            <span key={place} className="inline-flex items-center gap-1 text-muted-foreground">
              <ImageIcon aria-hidden="true" className="size-3.5" />
              {name}
            </span>
          )
        }
        const url = preview(part.id)
        return url ? (
          <img key={place} src={url} alt={name} className="max-h-80 max-w-full self-start rounded-md border" />
        ) : (
          // The box holds the image's place while its bytes load.
          <span key={place} role="img" aria-label={name} className="block h-40 w-60 max-w-full animate-pulse rounded-md border bg-muted" />
        )
      })}
    </div>
  )
}
