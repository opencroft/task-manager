// Server entry of the task manager extension: the `tasks` App (one project
// per instance, its data in a SQLite file in the instance's data directory).
// Agents reach its actions through `app_call`, the App's own UI through the
// host's `callAppAction`; both run the handlers below.

import {
  type AppActionContext,
  type AppActionHandler,
  type AppInstanceContext,
  type AppsExport,
  apps as hostApps,
} from '@opencroft/server/apps'
import type { ExtensionRoutes } from '@opencroft/server/routes'

import { ATTACHMENTS_ROUTE } from '../shared/attachments.ts'
import { withParamChecks } from './action-params.ts'
import { projectKeyOf, scopeFor, taskActions } from './actions.ts'
import { sweepAttachmentFiles } from './attachments/files.ts'
import { attachmentsRoute, type RouteScope } from './attachments/http.ts'
import { attachmentActions } from './attachments/index.ts'
import { boardActions } from './boards/index.ts'
import { withDetail } from './compact.ts'
import { closeInstanceDb, instanceDb } from './db.ts'
import { dependencyActions } from './dependencies/index.ts'
import { forgeActions, forgeHooks } from './forge/index.ts'
import { inboxActions } from './inbox/index.ts'
import { mentionActions } from './mentions/index.ts'
import { myWorkActions } from './my-work/index.ts'
import { openProjectActions, openProjectHooks } from './openproject/index.ts'
import { referenceActions, withProjectScope } from './projects/index.ts'
import { settingsActions } from './settings/index.ts'
import { versionActions } from './versions/index.ts'
import { viewActions } from './views/index.ts'
import { recoverWorkflowsOnLoad, workflowActions } from './workflows/index.ts'

/**
 * Every action of the `tasks` App: the task manager's, the workflows',
 * the inbox's, the dependencies', the saved views', the boards', My work's, the
 * attachments', the mentions', the project settings', the versions', the
 * OpenProject import's, then the forge links', each checking its parameters first. Those that take `detail` answer in compact rows unless
 * asked for the full shape. `task_list` and `my_work` take `scope`, to answer across projects.
 */
const allActions: Record<string, AppActionHandler> = withParamChecks(
  withDetail(
    withProjectScope({
      ...taskActions,
      ...workflowActions,
      ...inboxActions,
      ...dependencyActions,
      ...viewActions,
      ...boardActions,
      ...myWorkActions,
      ...attachmentActions,
      ...mentionActions,
      ...settingsActions,
      ...versionActions,
      ...openProjectActions,
      ...forgeActions,
    }),
  ),
)

function load(ctx: AppInstanceContext): void {
  projectKeyOf(ctx.params)
  sweepAttachmentFiles(instanceDb(ctx.instanceId, ctx.dataDir), ctx.dataDir)
  forgeHooks.start(ctx)
  openProjectHooks.start(ctx)
  void recoverWorkflowsOnLoad(ctx)
}

function unload(ctx: AppInstanceContext): void {
  forgeHooks.stop(ctx.instanceId)
  openProjectHooks.stop(ctx.instanceId)
  closeInstanceDb(ctx.instanceId)
}

// A route request acts on one of this extension's own `tasks` instances, in
// the context an App action gets when the same person calls it from the UI.
const routeScope: RouteScope = async (appId, person) => {
  const instance = (await hostApps.listInstances('tasks')).find((candidate) => candidate.instanceId === appId)
  return instance ? scopeFor({ ...instance, callerPerson: person } as unknown as AppActionContext) : null
}

/** Extension-level actions, called from client code outside any App: task keys in markdown. */
export const actions = referenceActions

/** HTTP routes, served only to signed-in people: attachment bytes, streamed. */
export const routes: ExtensionRoutes = {
  [ATTACHMENTS_ROUTE]: { session: 'person', handler: attachmentsRoute(routeScope) },
}

export const apps: AppsExport = {
  tasks: {
    onAdded: load,
    onLoad: load,
    // A new project key re-labels every task (keys are `<id>-<number>`); the
    // data itself stays. Without this hook the host would recreate the
    // instance and delete its database.
    onUpdated: (ctx) => {
      projectKeyOf(ctx.params)
      // The forge reads and the scheduled import use the new key from their next run on.
      forgeHooks.start(ctx)
      openProjectHooks.start(ctx)
    },
    onUnload: unload,
    onRemoved: unload,
    actions: allActions,
  },
}
