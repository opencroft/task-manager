import { defineExtension } from '@opencroft/client/extension'

import { TasksApp } from './app/tasks-app'
import { taskKeyResolver } from './lib/markdown-resolver'

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
