// Seam owned by the OpenProject import. The server entry spreads
// `openProjectActions` into the `tasks` App's actions: `import_openproject`
// (a preview, or with `confirm` the import), `import_openproject_state` (the
// saved connection, the last result and the schedule, for the Settings
// dialog) and `import_openproject_sync` (the schedule). It also starts and
// stops the schedule's timer with each instance. The import itself, and who
// may set the connection, is in ./import.ts.

import { type AppActionContext, type AppInstanceContext, apps } from '@opencroft/server/apps'
import { secrets } from '@opencroft/server/secrets'

import type { OpenProjectActionId } from '../../shared/openproject.ts'
import { typedActions } from '../action-params.ts'
import { scopeFor } from '../actions.ts'
import { instanceTimer, type TimerTarget } from '../instance-timer.ts'
import { TaskError } from '../service.ts'
import { importOpenProject, syncOpenProject } from './import.ts'
import { readState, recordSyncTry, saveSync, syncDue } from './store.ts'

/** Who the activity of a scheduled import is by. */
const SYNC_ACTOR = 'OpenProject sync'

const resolveSecret = (key: string) => secrets.resolve(key)

// Every minute each instance checks whether its schedule is due; one that is
// off costs a single-row read and no request.
const timer = instanceTimer('__taskPipelinesOpenProjectSync', 60)

async function tick(target: TimerTarget): Promise<void> {
  const ctx = target as unknown as AppActionContext
  const scope = scopeFor(ctx, { ctx, actor: { kind: 'person', name: SYNC_ACTOR } })
  if (!syncDue(scope, Date.now())) {
    return
  }
  try {
    await syncOpenProject(scope, { resolveSecret })
    recordSyncTry(scope, null)
  } catch (error) {
    recordSyncTry(scope, error instanceof Error ? error.message : String(error))
  }
}

timer.setTick(tick)

// A deploy reloads this module but runs no onLoad: make sure every instance
// already loaded has its timer, now running the tick above.
void apps
  .listInstances('tasks')
  .then((instances) => instances.forEach(timer.start))
  .catch(() => {
    // No host to ask (a test importing this module): onLoad starts them instead.
  })

export const openProjectHooks = {
  start: (ctx: AppInstanceContext) => timer.start(ctx),
  stop: (instanceId: string) => timer.stop(instanceId),
}

export const openProjectActions = typedActions<OpenProjectActionId, AppActionContext>(
  {
    import_openproject: (ctx, input) =>
      importOpenProject(scopeFor(ctx), input, {
        // Bound by the host from the session, never from the call: only the App's own UI sets it.
        byPerson: ctx.callerPerson !== undefined,
        resolveSecret,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
    import_openproject_state: (ctx) => readState(scopeFor(ctx)),
    import_openproject_sync: (ctx, { minutes }) => {
      const scope = scopeFor(ctx)
      if (minutes !== null && !readState(scope).lastImport) {
        throw new TaskError('Import once first: a scheduled import reuses the connection and mapping of the last one.')
      }
      saveSync(scope, minutes)
      return readState(scope)
    },
  },
  (ctx) => ctx,
)
