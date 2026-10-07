// Where a task opens. On a list page it opens in the peek beside the list,
// and the URL carries it (`…/board?peek=TASK-12`), so a reload keeps it; on a
// task's own page, the page moves to the other task. A Ctrl/Cmd-click opens
// the task's full page in a new tab instead, as a link would.

import { useCallback, useEffect } from 'react'

import {
  absoluteLink,
  currentLocation,
  hrefFor,
  hrefIn,
  isOwnApp,
  navigate,
  navigateIn,
  type TasksLocation,
  useTasksLocation,
} from '../lib/router'

const PEEK_PARAM = 'peek'
/** Query parameters about the open task (its summary in edit, a subtask being added, a linked comment), dropped when another task opens. */
const TASK_PARAMS = ['add', 'edit', 'comment']

/** A task's full page. */
export function taskHref(key: string): string {
  return hrefFor(['task', key])
}

/** Where a row of an answer across projects lives: another App, or this one (none). */
type Elsewhere = { app?: string } | null | undefined

const otherApp = (project: Elsewhere): string | null => (project?.app && !isOwnApp(project.app) ? project.app : null)

/** Whether a row across projects is another App's, which this App's task actions cannot act on. */
export function isElsewhere(project: Elsewhere): boolean {
  return otherApp(project) !== null
}

/** A task's full page, in whichever App it lives. */
export function taskHrefIn(key: string, project: Elsewhere): string {
  const app = otherApp(project)
  return app ? hrefIn(app, ['task', key]) : taskHref(key)
}

/** Opens a task where it lives: another project's in its own App, with Back returning here; this project's as `openTask` does. */
export function openTaskIn(key: string, project: Elsewhere): void {
  const app = otherApp(project)
  if (!app) {
    openTask(key)
  } else if (newTabClick) {
    window.open(absoluteLink(hrefIn(app, ['task', key])), '_blank', 'noopener')
  } else {
    navigateIn(app, ['task', key])
  }
}

function onTaskPage(location: TasksLocation): boolean {
  return location.segments[0] === 'task'
}

/** The task open in the peek: null when none is, and on a task's own page. */
export function peekKeyOf(location: TasksLocation): string | null {
  const key = location.query.get(PEEK_PARAM)
  return key && !onTaskPage(location) ? key.toUpperCase() : null
}

function withPeek(location: TasksLocation, key: string | null): string {
  const query = new URLSearchParams(location.query)
  for (const name of TASK_PARAMS) {
    query.delete(name)
  }
  if (key) {
    query.set(PEEK_PARAM, key)
  } else {
    query.delete(PEEK_PARAM)
  }
  return hrefFor(location.segments, query)
}

// True while a Ctrl/Cmd-click is being dispatched: set by a capture listener,
// which runs before any handler of that click, and cleared once it is over.
let newTabClick = false

function markClick(event: MouseEvent) {
  if (event.button === 0 && (event.ctrlKey || event.metaKey)) {
    newTabClick = true
    setTimeout(() => {
      newTabClick = false
    }, 0)
  }
}

/** Lets `openTask` tell a Ctrl/Cmd-click from a plain one. The App mounts it once. */
export function useNewTabClicks(): void {
  useEffect(() => {
    window.addEventListener('click', markClick, true)
    window.addEventListener('dblclick', markClick, true)
    return () => {
      window.removeEventListener('click', markClick, true)
      window.removeEventListener('dblclick', markClick, true)
    }
  }, [])
}

/** Opens a task: in the peek on a list, as the page on a task's page, in a new tab on a Ctrl/Cmd-click. */
export function openTask(key: string): void {
  if (newTabClick) {
    window.open(absoluteLink(taskHref(key)), '_blank', 'noopener')
    return
  }
  const here = currentLocation()
  if (onTaskPage(here)) {
    navigate(taskHref(key))
  } else if (peekKeyOf(here) !== key) {
    navigate(withPeek(here, key), { replace: true })
  }
}

/** Closes the peek; given a key, only when the peek shows that task. */
export function closePeek(key?: string): void {
  const here = currentLocation()
  const open = peekKeyOf(here)
  if (open && (key === undefined || open === key)) {
    navigate(withPeek(here, null), { replace: true })
  }
}

/** Where a link to a task goes from the current page: the same place `openTask` opens it. */
export function useTaskLink(): (key: string) => string {
  const location = useTasksLocation()
  return useCallback((key: string) => (onTaskPage(location) ? taskHref(key) : withPeek(location, key)), [location])
}
