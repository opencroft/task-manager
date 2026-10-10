// Seam owned by the forge links. The server entry spreads `forgeActions` into
// the `tasks` App's actions (`task_prs`, and the connection's status, connect
// and disconnect), and starts and stops the poller with each instance.
//
// The token is looked up in the Secrets Store by the key name saved with the
// connection, sent to the forge and dropped; it is never stored, logged or
// returned.

import { type AppActionContext, type AppInstanceContext, apps } from '@opencroft/server/apps'
import { secrets } from '@opencroft/server/secrets'

import type { ForgeActionId } from '../../shared/forge.ts'
import { type TypedHandlers, typedActions } from '../action-params.ts'
import { projectKeyOf, scopeFor } from '../actions.ts'
import { instanceDb } from '../db.ts'
import { broadcastTasksChanged } from '../live.ts'
import { requireRow, TaskError } from '../service.ts'
import { forgeClient } from './api.ts'
import { checkConnection, usableConnection } from './connect.ts'
import { type PollTarget, pollNow, setTick, startPolling, stopPolling } from './poller.ts'
import { deleteConnection, pullRequestsOf, readStatus, recordSync, saveConnection } from './store.ts'
import { syncOnce } from './sync.ts'

/** One read for one instance, as every timer runs it. */
async function tick(target: PollTarget): Promise<void> {
  const db = instanceDb(target.instanceId, target.dataDir)
  const { connection, problem } = usableConnection(db)
  if (problem) {
    recordSync(db, { at: new Date().toISOString(), error: problem })
    return
  }
  if (!connection) {
    return
  }
  const token = await secrets.resolve(connection.secretKey)
  if (!token) {
    recordSync(db, { at: new Date().toISOString(), error: `The Secrets Store has no key "${connection.secretKey}"` })
    return
  }
  const projectKey = projectKeyOf(target.params)
  const first = readStatus(db).lastSyncAt === null
  const { changed } = await syncOnce(
    db,
    projectKey,
    forgeClient({ url: connection.url, token, secretKey: connection.secretKey }),
  )
  if (changed.length > 0 || first) {
    // After the first read even with no links, so a settings page waiting on it hears that it finished.
    broadcastTasksChanged(
      target.instanceId,
      changed.map((number) => `${projectKey}-${number}`),
      'task',
    )
  }
}

setTick(tick)

// A deploy reloads this module but runs no onLoad: make sure every instance
// already loaded has its timer, now running the tick above.
void apps
  .listInstances('tasks')
  .then((instances) => instances.forEach(startPolling))
  .catch(() => {
    // No host to ask (a test importing this module): onLoad starts them instead.
  })

export const forgeHooks = {
  start: (ctx: AppInstanceContext) => startPolling(ctx),
  stop: (instanceId: string) => stopPolling(instanceId),
}

const byPerson = (ctx: AppActionContext) => ctx.callerPerson !== undefined

const handlers: TypedHandlers<ForgeActionId, AppActionContext> = {
  task_prs: (ctx, input) => {
    const scope = scopeFor(ctx)
    const row = requireRow(scope, input.key)
    return { key: `${scope.projectKey}-${row.number}`, pullRequests: pullRequestsOf(scope, row.number) }
  },
  forge_status: (ctx) => readStatus(scopeFor(ctx).db),
  forge_connect: async (ctx, input) => {
    const scope = scopeFor(ctx)
    const connection = checkConnection(input, byPerson(ctx))
    if (!(await secrets.resolve(connection.secretKey))) {
      throw new TaskError(
        `The Secrets Store has no key "${connection.secretKey}": store the forge token under it first`,
      )
    }
    saveConnection(scope.db, connection)
    startPolling(ctx)
    // The first read may take a while on a large forge; the page learns of it from the tasks it links.
    void pollNow(ctx.instanceId)
    return readStatus(scope.db)
  },
  forge_disconnect: (ctx) => {
    const scope = scopeFor(ctx)
    if (!byPerson(ctx)) {
      throw new TaskError('Only a person disconnects the forge, in Settings → Pull requests.')
    }
    deleteConnection(scope.db)
    scope.notify([], 'task')
    return readStatus(scope.db)
  },
}

export const forgeActions = typedActions(handlers, (ctx) => ctx)
