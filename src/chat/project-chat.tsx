// The project's agent chat beside the App: the host's ChatDock around the
// pages, in the space's chat (the one mention sessions and workflow steps use,
// and the one the host treats as the space's own), with what the reader has
// open or picked offered to the composer (chat-selection.ts).
//
// The selection goes into the scope the host mounts on the App's page: the
// composer shows it as the quote, and the reader's pass toggle holds it back
// from a message. This component is its only publisher, so a page that drops
// its picked tasks hands back to the open task or the page rather than
// clearing the quote.

import { ChatDock, usePublishSelection } from '@opencroft/client/chat'
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'

import type { ProjectInfo } from '../../shared/settings'
import { tasksApi } from '../lib/api'
import { type ChatPlace, chatSelection } from './chat-selection'

/** Where a page reports the tasks it has picked. Outside the chat, nowhere. */
const PickedTasks = createContext<(keys: string[]) => void>(() => {})

/**
 * Offers `keys`, the tasks a page has picked, to the chat in place of the open
 * task or the page, until the keys are empty or the page unmounts.
 */
export function usePickedTasks(keys: readonly string[]): void {
  const report = useContext(PickedTasks)
  // By value: a page hands over a fresh array on every render. Task keys hold no newline.
  const joined = keys.join('\n')
  useEffect(() => {
    report(joined ? joined.split('\n') : [])
  }, [report, joined])
  useEffect(() => () => report([]), [report])
}

/**
 * The App's pages inside the space's chat dock. Renders nothing until it
 * knows the space, so the pages mount once, inside the dock, rather than again
 * when the dock arrives. The dock itself offers a person outside the chat to
 * join it: being in the space entitles them.
 */
export function ProjectChat({
  instanceId,
  projectKey,
  place,
  children,
}: {
  instanceId: string
  projectKey: string
  place: ChatPlace
  children: ReactNode
}) {
  // The App's address is what an agent passes to `app_call`; the instance id is not.
  // `failed`: the project could not be read, so the pages show without a chat rather than not at all.
  const [info, setInfo] = useState<ProjectInfo | 'failed' | null>(null)
  const [picked, setPicked] = useState<string[]>([])

  useEffect(() => {
    let live = true
    tasksApi(instanceId)
      .project_info({})
      .then(
        (next) => live && setInfo(next),
        () => live && setInfo('failed'),
      )
    return () => {
      live = false
    }
  }, [instanceId])

  usePublishSelection(info && info !== 'failed' ? chatSelection(info.address, place, picked) : null)

  if (info === 'failed') {
    return <>{children}</>
  }
  if (!info) {
    return null
  }
  return (
    <ChatDock
      space={info.space}
      id={`tasks-${projectKey.toLowerCase()}`}
      title={`Chat · ${info.name}`}
      chatName={info.name}
    >
      <PickedTasks.Provider value={setPicked}>{children}</PickedTasks.Provider>
    </ChatDock>
  )
}
