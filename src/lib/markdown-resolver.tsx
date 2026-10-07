// Task keys in any markdown the product shows, drawn as the task they name
// (see shared/references.ts). Recognises only the keys of projects that exist,
// so `UTF-8` or `GPT-4` stay text.

import { legacy, type MarkdownReference, type MarkdownResolver } from '@opencroft/client'

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

interface EventStream {
  subscribe(fn: (chunk: { name?: string; payload?: Record<string, unknown> }) => void): () => void
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
    state: <TaskStatusBadge size="sm" name={task.status.name} category={task.status.category} color={task.status.color} />,
    href: taskHref(task.app, task.key),
  }
}

const events = () => legacy.getStream(legacy.extensionId, 'events') as unknown as EventStream

function onTasksEvent(listener: (event: TasksEvent) => void): () => void {
  return events().subscribe((chunk) => {
    if (chunk?.name === TASKS_EVENT && chunk.payload) {
      listener(chunk.payload as unknown as TasksEvent)
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
    legacy
      .invoke<ReferenceProject[]>(REFERENCE_ACTIONS.projects)
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
      const tasks = await legacy.invoke<Record<string, TaskReference | null>>(
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
          () => legacy.toast.success('Copied', { duration: 1500 }),
          () => legacy.toast.error('Could not copy to the clipboard'),
        )
      },
    },
  ],
}
