// Typed access to the workflow actions from the UI, through the host's
// `callAppAction` as the task pages use it — the UI runs the handlers an
// agent's `app_call` runs, as the signed-in person, and has no private path to
// the data.

import { callAppAction } from '@opencroft/client'

import { withFullDetail } from '../lib/api'

import type { Status } from '../../shared/types'
import type {
  ApprovalVerdict,
  OpenApproval,
  RunState,
  RunsMatch,
  SpaceChatState,
  Spent,
  StatsRange,
  ValidationIssue,
  WorkflowDef,
  WorkflowDraft,
  WorkflowRun,
  WorkflowStats,
} from '../../shared/workflows'

export interface RunView {
  task: { key: string; summary: string; status: string }
  run: WorkflowRun | null
  /** `approval`: present when the open step is an approval step. */
  openStep: { name: string; agent: string | null; transitions: string[]; approval?: OpenApproval } | null
  history: WorkflowRun[]
  /** Across every run of the task: wall time of its rounds, and what its agent sessions spent. */
  spent: Spent
}

interface WorkflowActions {
  workflows_list: [Record<string, never>, { workflows: WorkflowDef[]; statuses: Status[] }]
  workflow_get: [{ workflow: string }, WorkflowDef]
  space_chat: [Record<string, never>, SpaceChatState]
  space_chat_grant: [Record<string, never>, SpaceChatState]
  workflow_validate: [{ workflow: WorkflowDraft }, { issues: ValidationIssue[] }]
  workflow_save: [{ workflow: WorkflowDraft }, WorkflowDef]
  workflow_delete: [{ workflow: string }, { deleted: string }]
  workflow_start: [{ task: string; workflow?: string }, WorkflowRun]
  workflow_run_get: [{ task: string }, RunView]
  workflow_step_finish: [{ task: string; transition: string; summary?: string }, WorkflowRun]
  workflow_step_decide: [{ task: string; verdict: ApprovalVerdict; transition: string; comment?: string }, WorkflowRun]
  workflow_step_restart: [{ task: string; step: string }, WorkflowRun]
  workflow_run_cancel: [{ task: string }, WorkflowRun]
  /** With `match`, `total` counts every matching run while `runs` stops at the limit. */
  workflow_runs_list: [{ state?: RunState; workflow?: string; limit?: number; match?: RunsMatch }, { runs: WorkflowRun[]; total?: number }]
  workflow_stats: [{ workflow: string; range?: StatsRange }, WorkflowStats]
}

export type WorkflowsApi = {
  [A in keyof WorkflowActions]: (params: WorkflowActions[A][0]) => Promise<WorkflowActions[A][1]>
}

export function workflowsApi(instanceId: string): WorkflowsApi {
  return new Proxy({} as WorkflowsApi, {
    get: (_target, action: string) => (params: Record<string, unknown>) => callAppAction(instanceId, action, withFullDetail(action, params)),
  })
}

/** The host's page for one group-chat thread. */
export function threadHref(chatRef: string, threadId: string): string {
  return `/group-chats/${encodeURIComponent(chatRef)}/${encodeURIComponent(threadId)}`
}
