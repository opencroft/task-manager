// Typed access to the workflow actions from the UI, through the host's
// `callAppAction` as the task pages use it — the UI runs the handlers an
// agent's `app_call` runs, as the signed-in person, and has no private path to
// the data.

import { callAppAction } from '@opencroft/client/actions'

import type { ActionInputs } from '../../shared/action-inputs'
import type { Status } from '../../shared/types'
import type {
  OpenApproval,
  RunsMatch,
  SpaceChatState,
  Spent,
  ValidationIssue,
  WorkflowDef,
  WorkflowDraft,
  WorkflowRun,
  WorkflowStats,
} from '../../shared/workflows'
import { type CheckedActionMap, withFullDetail } from '../lib/api'

export interface RunView {
  task: { key: string; summary: string; status: string }
  run: WorkflowRun | null
  /** `approval`: present when the open step is an approval step. */
  openStep: { name: string; agent: string | null; transitions: string[]; approval?: OpenApproval } | null
  history: WorkflowRun[]
  /** Across every run of the task: wall time of its rounds, and what its agent sessions spent. */
  spent: Spent
}

type WorkflowActions = CheckedActionMap<{
  workflows_list: { input: ActionInputs['workflows_list']; output: { workflows: WorkflowDef[]; statuses: Status[] } }
  workflow_get: { input: ActionInputs['workflow_get']; output: WorkflowDef }
  space_chat: { input: ActionInputs['space_chat']; output: SpaceChatState }
  space_chat_grant: { input: ActionInputs['space_chat_grant']; output: SpaceChatState }
  workflow_validate: { input: { workflow: WorkflowDraft }; output: { issues: ValidationIssue[] } }
  workflow_save: { input: { workflow: WorkflowDraft }; output: WorkflowDef }
  workflow_delete: { input: ActionInputs['workflow_delete']; output: { deleted: string } }
  workflow_start: { input: ActionInputs['workflow_start']; output: WorkflowRun }
  workflow_run_get: { input: ActionInputs['workflow_run_get']; output: RunView }
  workflow_step_finish: { input: ActionInputs['workflow_step_finish']; output: WorkflowRun }
  workflow_step_decide: { input: ActionInputs['workflow_step_decide']; output: WorkflowRun }
  workflow_step_restart: { input: ActionInputs['workflow_step_restart']; output: WorkflowRun }
  workflow_run_cancel: { input: ActionInputs['workflow_run_cancel']; output: WorkflowRun }
  /** With `match`, `total` counts every matching run while `runs` stops at the limit. */
  workflow_runs_list: {
    input: Omit<ActionInputs['workflow_runs_list'], 'match'> & { match?: RunsMatch }
    output: { runs: WorkflowRun[]; total?: number }
  }
  workflow_stats: { input: ActionInputs['workflow_stats']; output: WorkflowStats }
}>

export type WorkflowsApi = {
  [A in keyof WorkflowActions]: (params: WorkflowActions[A]['input']) => Promise<WorkflowActions[A]['output']>
}

export function workflowsApi(instanceId: string): WorkflowsApi {
  return new Proxy({} as WorkflowsApi, {
    get: (_target, action: string) => (params: Record<string, unknown>) =>
      callAppAction(instanceId, action, withFullDetail(action, params)),
  })
}

/** The host's page for one group-chat thread. */
export function threadHref(chatRef: string, threadId: string): string {
  return `/group-chats/${encodeURIComponent(chatRef)}/${encodeURIComponent(threadId)}`
}
