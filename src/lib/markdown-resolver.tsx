// Task keys in any markdown the product shows, drawn as the task they name
// (see shared/references.ts). Recognises only the keys of projects that exist,
// so `UTF-8` or `GPT-4` stay text.

import { invoke } from '@opencroft/client/actions'
import { extensionId } from '@opencroft/client/extension'
import type { MarkdownReference, MarkdownResolver } from '@opencroft/client/markdown'
import { getStream } from '@opencroft/client/streams'
import { toast } from 'sonner'

import { TaskStatusBadge } from '@/components/ui/tasks/task-status-badge'
import { TaskTypeIcon } from '@/components/ui/tasks/task-type-icon'
import {
  REFERENCE_ACTIONS,
  REFERENCE_RESOLVE_MAX,
  type ReferenceProject,
  type TaskReference,
  taskKeyPattern,
} from '../../shared/references'
import { TASKS_EVENT, type TasksEvent } from '../../shared/types'

/** One chunk of the extension's `events` stream, as the server broadcasts it. */
interface TasksEventChunk {
  name?: string
  payload?: TasksEvent
}

const taskHref = (app: string, key: string) => {
  const dot = app.indexOf('.')
  return `/space/${encodeURIComponent(app.slice(0, dot))}/app/${encodeURIComponent(app.slice(dot + 1))}/task/${key}`
}

// Drawn with the task manager's own type glyph and status badge, so a task
// reads the same in a chat line as on the board.
function toReference(task: TaskReference): MarkdownReference {
  return {
    label: task.key,
    detail: task.summary,
    icon: <TaskTypeIcon type={task.type} />,
    state: (
      <TaskStatusBadge size='sm' name={task.status.name} category={task.status.category} color={task.status.color} />
    ),
    href: taskHref(task.app, task.key),
  }
}

const events = () => getStream<TasksEventChunk>(extensionId, 'events')

function onTasksEvent(listener: (event: TasksEvent) => void): () => void {
  return events().subscribe((chunk) => {
    if (chunk?.name === TASKS_EVENT && chunk.payload) {
      listener(chunk.payload)
    }
  })
}

// The projects are read once, when something first watches the pattern, and
// again only when an event arrives from an App not among them -- a project
// added since.
function watchPattern(set: (pattern: string | null) => void): () => void {
  let known: Set<string> | null = null
  let reading = false
  const read = () => {
    if (reading) {
      return
    }
    reading = true
    invoke<ReferenceProject[]>(REFERENCE_ACTIONS.projects)
      .then((projects) => {
        known = new Set(projects.map((project) => project.instanceId))
        set(taskKeyPattern(projects))
      })
      .catch((error) => console.error('[task-pipelines] could not read the projects for task keys', error))
      .finally(() => {
        reading = false
      })
  }
  read()
  return onTasksEvent((event) => {
    if (known && !known.has(event.instanceId)) {
      read()
    }
  })
}

export const taskKeyResolver: MarkdownResolver = {
  id: 'tasks.key',
  pattern: null,
  watchPattern,
  preview: () => ({ icon: 'SquareCheck' }),
  resolve: async (keys) => {
    const answers: Record<string, MarkdownReference | null> = {}
    for (let at = 0; at < keys.length; at += REFERENCE_RESOLVE_MAX) {
      const tasks = await invoke<Record<string, TaskReference | null>>(
        REFERENCE_ACTIONS.resolve,
        keys.slice(at, at + REFERENCE_RESOLVE_MAX),
      )
      for (const [key, task] of Object.entries(tasks)) {
        answers[key] = task ? toReference(task) : null
      }
    }
    return answers
  },
  // Every change broadcasts the keys it touched; a project-wide one (a status
  // renamed) touches none by name, so everything is asked again.
  subscribe: (invalidate) => onTasksEvent((event) => invalidate(event.keys.length ? event.keys : undefined)),
  menu: (key) => [
    {
      label: 'Copy key',
      icon: 'Copy',
      onSelect: () => {
        navigator.clipboard.writeText(key).then(
          () => toast.success('Copied', { duration: 1500 }),
          () => toast.error('Could not copy to the clipboard'),
        )
      },
    },
  ],
}
