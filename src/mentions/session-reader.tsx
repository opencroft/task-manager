// One mention session's thread, read in place: the host's embedded chat.

import { legacy } from '@opencroft/client'
import { type ComponentType, useState } from 'react'

import { threadHref } from '../workflows/api'

interface EmbeddedChatProps {
  space: string
  id: string
  thread?: { threadId: string } | null
  onChatAvailable?: (available: boolean) => void
  className?: string
}

// The host's chat surface; absent on a host too old to offer it.
const EmbeddedAgentChat = (legacy as unknown as { EmbeddedAgentChat?: ComponentType<EmbeddedChatProps> }).EmbeddedAgentChat

export interface SessionReaderProps {
  chatSlug: string
  /** The chat's id, for the link out; the slug serves when it is missing. */
  chatRef?: string | null
  threadId: string
}

export function SessionReader({ chatSlug, chatRef, threadId }: SessionReaderProps) {
  const [available, setAvailable] = useState<boolean | null>(null)
  const note = 'text-sm text-muted-foreground'
  if (!EmbeddedAgentChat) {
    return (
      <p className={note}>
        This host cannot show a session here.{' '}
        <a className="text-primary hover:underline" href={threadHref(chatRef ?? chatSlug, threadId)}>
          Open it in its chat
        </a>
        .
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      {available === false ? <p className={note}>The session lives in the “{chatSlug}” chat. Join that chat to read it here.</p> : null}
      <div className="h-[28rem] overflow-hidden rounded-md border">
        <EmbeddedAgentChat
          key={threadId}
          space={chatSlug}
          id={threadId}
          thread={{ threadId }}
          onChatAvailable={setAvailable}
          className="h-full"
        />
      </div>
    </div>
  )
}
