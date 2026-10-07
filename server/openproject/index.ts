// Seam owned by the OpenProject import. The server entry spreads
// `openProjectActions` into the `tasks` App's actions: `import_openproject`
// (a preview, or with `confirm` the import), `import_openproject_state` (the
// saved connection, the last result and the schedule, for the Settings
// dialog) and `import_openproject_sync` (the schedule). It also starts and
// stops the schedule's timer with each instance. The import itself, and who
// may set the connection, is in ./import.ts.

import type { AppActionContext, AppActionHandler, AppInstanceContext } from '@opencroft/server'
import host from '@opencroft/server'

import { OPENPROJECT_SYNC_MINUTES, type OpenProjectActionId, type OpenProjectImportInput } from '../../shared/openproject.ts'
import { scopeFor } from '../actions.ts'
import { type TimerTarget, instanceTimer } from '../instance-timer.ts'
import { TaskError } from '../service.ts'
import { importOpenProject, syncOpenProject } from './import.ts'
import { readState, recordSyncTry, saveSync, syncDue } from './store.ts'

/** Who the activity of a scheduled import is by. */
const SYNC_ACTOR = 'OpenProject sync'

const resolveSecret = (key: string) => host.secrets.resolve(key)

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
void host.apps
  .listInstances('tasks')
  .then((instances) => instances.forEach(timer.start))
  .catch(() => {
    // No host to ask (a test importing this module): onLoad starts them instead.
  })

export const openProjectHooks = {
  start: (ctx: AppInstanceContext) => timer.start(ctx),
  stop: (instanceId: string) => timer.stop(instanceId),
}

function cleanMinutes(value: unknown): number | null {
  if (value === null) {
    return null
  }
  if (!OPENPROJECT_SYNC_MINUTES.includes(value as (typeof OPENPROJECT_SYNC_MINUTES)[number])) {
    throw new TaskError(`minutes is one of ${OPENPROJECT_SYNC_MINUTES.join(', ')}, or null to stop importing on a schedule.`)
  }
  return value as number
}

const handlers: Record<OpenProjectActionId, (ctx: AppActionContext, params: Record<string, unknown>) => unknown> = {
  import_openproject: (ctx, params) =>
    importOpenProject(scopeFor(ctx), params as OpenProjectImportInput, {
      // Bound by the host from the session, never from the call: only the App's own UI sets it.
      byPerson: ctx.callerPerson !== undefined,
      resolveSecret,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
  import_openproject_state: (ctx) => readState(scopeFor(ctx)),
  import_openproject_sync: (ctx, params) => {
    const scope = scopeFor(ctx)
    const minutes = cleanMinutes(params.minutes)
    if (minutes !== null && !readState(scope).lastImport) {
      throw new TaskError('Import once first: a scheduled import reuses the connection and mapping of the last one.')
    }
    saveSync(scope, minutes)
    return readState(scope)
  },
}

export const openProjectActions: Record<string, AppActionHandler> = Object.fromEntries(
  Object.entries(handlers).map(([id, handler]) => [id, (ctx: AppActionContext, params: Record<string, unknown>) => handler(ctx, params ?? {})]),
)
