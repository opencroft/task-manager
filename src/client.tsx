import { legacy } from '@opencroft/client'

import { TasksApp } from './app/tasks-app'
import { taskKeyResolver } from './lib/markdown-resolver'

const { defineExtension } = legacy

export default defineExtension({
  manifest: {},
  provides: {
    apps: [
      {
        type: 'tasks',
        title: 'Tasks',
        description: 'A task manager for one project: tasks and subtasks, statuses, timeline, board and workflows.',
        icon: 'ListTodo',
        component: TasksApp,
      },
    ],
    markdownResolvers: [taskKeyResolver],
  },
})
