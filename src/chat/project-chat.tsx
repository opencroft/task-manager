// The project's agent chat beside the App: the host's ChatDock around the
// pages, in the space's chat (the one mention sessions and workflow steps use,
// and the one the host treats as the space's own), with the page and the
// task the reader has open offered to the composer as references. A reference
// names what is open and how to read it (the App's own actions); it never
// carries the task's text, so the agent reads the current state itself.
//
// The references ride the host's selection scope: the composer shows them as a
// badge, and the reader's pass toggle holds them back from a message.

import { ChatDock, SelectionProvider, type UserSelection, useSelection } from '@opencroft/client/chat'
import { type ReactNode, useEffect, useState } from 'react'

import type { ProjectInfo } from '../../shared/settings'
import { tasksApi } from '../lib/api'

/** Where the reader is in the App, for the reference. */
export interface ChatPlace {
  /** The page's name as the App's sidebar shows it, e.g. "Board"; null on a task's own page. */
  page: string | null
  /** The App path of the page, e.g. `/board`. */
  path: string
  /** The task open on its own page or in the peek. */
  taskKey: string | null
}

/** The reference text the agent receives, and the badge the reader sees. */
export function referenceOf(app: string, projectKey: string, place: ChatPlace): UserSelection {
  const lines = [
    `Task manager App ${app} (project ${projectKey}); the reader is on: ${place.page ?? 'a task page'} (${place.path})`,
  ]
  if (place.taskKey) {
    lines.push(`Open task: ${place.taskKey}`)
    lines.push(`Read it with app_call on ${app}: task_get {"key":"${place.taskKey}"}`)
  } else {
    lines.push(`Read the page's tasks with app_call on ${app}: task_list`)
  }
  return {
    label: [place.page, place.taskKey].filter(Boolean).join(' · '),
    content: lines.join('\n'),
  }
}

function ReferenceBridge({ app, projectKey, place }: { app: string; projectKey: string; place: ChatPlace }) {
  const { setSelection } = useSelection()
  const { page, path, taskKey } = place
  useEffect(() => {
    setSelection(referenceOf(app, projectKey, { page, path, taskKey }))
  }, [app, projectKey, page, path, taskKey, setSelection])
  return null
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

  if (info === 'failed') {
    return <>{children}</>
  }
  if (!info) {
    return null
  }
  return (
    <SelectionProvider>
      <ChatDock
        space={info.space}
        id={`tasks-${projectKey.toLowerCase()}`}
        title={`Chat · ${info.name}`}
        chatName={info.name}
      >
        <ReferenceBridge app={info.address} projectKey={projectKey} place={place} />
        {children}
      </ChatDock>
    </SelectionProvider>
  )
}
