// One mention session's thread, read in place: the host's embedded chat.

import { EmbeddedAgentChat } from '@opencroft/client/chat'
import { useState } from 'react'

export interface SessionReaderProps {
  chatSlug: string
  threadId: string
}

export function SessionReader({ chatSlug, threadId }: SessionReaderProps) {
  const [available, setAvailable] = useState<boolean | null>(null)
  const note = 'text-sm text-muted-foreground'
  return (
    <div className='flex flex-col gap-1'>
      {available === false ? (
        <p className={note}>The session lives in the “{chatSlug}” chat. Join that chat to read it here.</p>
      ) : null}
      <div className='h-[28rem] overflow-hidden rounded-md border'>
        <EmbeddedAgentChat
          key={threadId}
          space={chatSlug}
          id={threadId}
          thread={{ threadId }}
          onChatAvailable={setAvailable}
          className='h-full'
        />
      </div>
    </div>
  )
}
