// What the project chat is offered about where the reader is: the items the
// host turns into the quote above the composer and the block the agent
// receives, each with the App action that reads it. No task text travels; the
// agent reads the current state itself.

import type { Selection, SelectionItem } from '@opencroft/client/chat'

/** Where the reader is in the App, for the chat. */
export interface ChatPlace {
  /** The page's name as the App's sidebar shows it, e.g. "Board"; null on a task's own page. */
  page: string | null
  /** The App path of the page, e.g. `/board`. */
  path: string
  /** The task open on its own page or in the peek. */
  taskKey: string | null
}

/**
 * The chat's selection on the App at address `app`. Tasks picked on the Board
 * or in the List come first: picking is the reader pointing at those tasks,
 * even with another one open in the peek. Without any, the open task; without
 * that, the page, read with `task_list`.
 */
export function chatSelection(app: string, place: ChatPlace, picked: readonly string[]): Selection {
  const keys = picked.length > 0 ? picked : place.taskKey ? [place.taskKey] : []
  if (keys.length > 0) {
    return { items: keys.map((key) => taskItem(app, key)) }
  }
  return {
    items: [
      { kind: 'app', app, action: 'task_list', params: {}, name: place.page ?? place.path, noun: ['page', 'pages'] },
    ],
  }
}

function taskItem(app: string, key: string): SelectionItem {
  return { kind: 'app', app, action: 'task_get', params: { key }, name: key, noun: ['task', 'tasks'] }
}
