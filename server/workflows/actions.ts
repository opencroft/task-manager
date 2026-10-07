/**
 * The workflow half of the `tasks` App's actions: what an agent (through
 * `app_call`) and the UI (through the same handlers) can do with workflows.
 *
 * Handlers are built over a `WorkflowHost`: how to reach the project's
 * database, a task, the task model's status change and the group chats. The
 * server entry (index.ts) supplies the real one; tests supply their own. Each
 * handler checks its params itself and refuses with a message that says what
 * to pass instead, because the caller is often an agent reading it cold.
 */

import type { AppActionContext, AppActionHandler } from '@opencroft/server'

import type { Actor, Status, TaskSummary } from '../../shared/types.ts'
import {
  APPROVAL_VERDICTS,
  type ApprovalVerdict,
  COULDNT_START_REASONS,
  type CouldntStartKey,
  type OpenApproval,
  RUN_EXITS,
  type RunExit,
  type RunsMatch,
  type RunState,
  type RunStep,
  STATS_RANGES,
  type SpaceChatState,
  type StatsRange,
  verdictTransitions,
  type WorkflowDef,
  type WorkflowDraft,
  type WorkflowRun,
  type WorkflowStepDef,
} from '../../shared/workflows.ts'
import type { Db } from '../db.ts'
import { findSpaceChat, type SpaceChatListing } from '../space-chat.ts'
import { normalizeDraft, validateWorkflow } from './definition.ts'
import {
  cancelRun,
  type ChatsPort,
  decideStep,
  type EngineEnv,
  finishStep,
  restartStep,
  startWorkflow,
  type TaskPort,
} from './engine.ts'
import {
  activeRunForTask,
  deleteWorkflow,
  findWorkflow,
  getWorkflow,
  listRuns,
  listWorkflows,
  mintId,
  runsForTask,
  saveWorkflow,
} from './store.ts'
import { pendingRunIds, workflowStats } from './stats.ts'
import { matchingRunIds, rangeStart } from './stats-flow.ts'
import { settlePendingUsage, sumSpent, withLiveUsage } from './usage.ts'

/** The system member a chat needs so the workflow can open sessions in it. */
export const WORKFLOW_SYSTEM_MEMBER = 'system.ext.opencroft.task-manager'

export interface WorkflowHost {
  open(ctx: AppActionContext): { db: Db; projectKey: string }
  getTask(ctx: AppActionContext, key: string): TaskSummary
  actor(ctx: AppActionContext): Actor
  /** The signed-in person calling from the App's UI; null for an agent or an internal call. */
  person(ctx: AppActionContext): { id: string; name: string } | null
  /** The host's directory of people: who can be an approver. */
  people(ctx: AppActionContext): Promise<Array<{ id: string; name: string }>>
  /** The task model's status change, as this caller. */
  tasks(ctx: AppActionContext, actor: Actor): TaskPort
  /** The group chats the workflow acts in — the extension's own identity. */
  chats(): ChatsPort | null
  /** The signed-in person's own chats and the grant, when a person called from the UI; null otherwise. */
  personChats(ctx: AppActionContext): PersonChatsPort | null
  /** `<space>.<app>`: the address an agent passes to `app_call`. */
  appAddress(ctx: AppActionContext): Promise<string>
  /** Tell open views that workflow data changed. */
  changed(ctx: AppActionContext, keys: string[]): void
  now(): string
  /** The inbox the engine reports steps and run endings to; absent where nothing listens. */
  inbox?(ctx: AppActionContext): EngineEnv['inbox']
  /** The host's agents, to name one who is not in the space's chat; absent where nothing needs it. */
  agents?(ctx: AppActionContext): Promise<Array<{ id: string; name: string }>>
}

function str(params: Record<string, unknown>, name: string, hint: string): string {
  const value = params[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`"${name}" is required: ${hint}`)
  }
  return value.trim()
}

function optStr(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** The step fields `workflow_step_update` can change; anything not passed keeps its value. */
const STEP_FIELDS = [
  'name',
  'triggerStatus',
  'kind',
  'worker',
  'approval',
  'instructions',
  'transitions',
  'folder',
  'sessionOptions',
] as const

function requireWorkflow(db: Db, params: Record<string, unknown>): WorkflowDef {
  const ref = str(params, 'workflow', 'the workflow id or name, from workflows_list')
  const wf = findWorkflow(db, ref)
  if (!wf) {
    const names = listWorkflows(db).map((w) => `"${w.name}"`)
    throw new Error(`No workflow "${ref}" in this project. Workflows: ${names.join(', ') || 'none yet'}`)
  }
  return wf
}

/** `workflow_runs_list`'s `match`, checked against the workflow it selects runs of. */
function runsMatch(raw: unknown, workflow: WorkflowDef): RunsMatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('"match" must be an object: {"range", "step", and optionally "exit", "transition", "rounds", "couldntStart"}')
  }
  const match = raw as Record<string, unknown>
  const range = (optStr(match, 'range') ?? '30d') as StatsRange
  if (!STATS_RANGES.includes(range)) {
    throw new Error(`"match.range" must be one of: ${STATS_RANGES.join(', ')}`)
  }
  const ref = str(match, 'step', 'the id or name of one of the workflow\'s steps')
  const step = workflow.steps.find((s) => s.id === ref) ?? workflow.steps.find((s) => s.name.toLowerCase() === ref.toLowerCase())
  if (!step) {
    throw new Error(`"${workflow.name}" has no step "${ref}". Steps: ${workflow.steps.map((s) => `"${s.name}"`).join(', ')}`)
  }
  const exit = optStr(match, 'exit') as RunExit | undefined
  if (exit && !RUN_EXITS.includes(exit)) {
    throw new Error(`"match.exit" must be one of: ${RUN_EXITS.join(', ')}`)
  }
  const rounds = match.rounds
  if (rounds !== undefined && !(rounds === 1 || rounds === 2 || rounds === 3 || rounds === 4)) {
    throw new Error('"match.rounds" must be 1, 2, 3, or 4 for four or more')
  }
  const couldntStart = optStr(match, 'couldntStart') as CouldntStartKey | undefined
  if (couldntStart && couldntStart !== 'unrecorded' && !COULDNT_START_REASONS.includes(couldntStart)) {
    throw new Error(`"match.couldntStart" must be one of: ${[...COULDNT_START_REASONS, 'unrecorded'].join(', ')}`)
  }
  return { range, step: step.id, exit, transition: optStr(match, 'transition'), rounds, couldntStart }
}

function statusList(db: Db): Status[] {
  return db.prepare('SELECT id, name, category, color, position FROM status ORDER BY position').all() as unknown as Status[]
}

/** An open approval step as the caller sees it: its approvers' decisions in the open round, and whether the caller decides. */
function openApproval(
  workflow: WorkflowDef,
  step: WorkflowStepDef,
  open: RunStep,
  caller: { id: string } | null,
): OpenApproval {
  const decisions = open.rounds.at(-1)?.decisions ?? []
  const approvers = step.approval?.approvers ?? []
  const byVerdict = verdictTransitions(workflow.steps, step)
  return {
    needed: step.approval?.needed ?? 0,
    approvers: approvers.map((a) => ({ ...a, decision: decisions.find((d) => d.approver.personId === a.personId) ?? null })),
    transitions: { approve: byVerdict.approve.map((t) => t.label), reject: byVerdict.reject.map((t) => t.label) },
    canDecide: caller !== null && approvers.some((a) => a.personId === caller.id),
    viewerId: caller?.id ?? null,
  }
}

/** A person's view of their chats, as the host's person-bound `groupChats` offers it. */
export interface PersonChatsPort {
  personChats(): Promise<Array<SpaceChatListing & { extensionGranted: boolean }>>
  grantExtension(chat: string): Promise<void>
}

export function makeWorkflowActions(host: WorkflowHost): Record<string, AppActionHandler> {
  /**
   * The space's chat as this caller can see it. The task manager's own list
   * says whether it is in the chat; a person's list also says whether they
   * are, which decides whether they can grant it.
   */
  const spaceChat = async (ctx: AppActionContext): Promise<SpaceChatState> => {
    const slug = ctx.spaceSlug
    const person = host.personChats(ctx)
    const mine = person ? ((await person.personChats()).find((chat) => chat.slug === slug) ?? null) : null
    const chats = host.chats()
    const ours = chats ? await findSpaceChat(chats, slug) : null
    const seen = ours ?? mine
    return {
      slug,
      ref: seen?.ref ?? null,
      name: seen?.name ?? null,
      taskManagerIn: ours !== null,
      agents: seen?.agents ?? [],
      youAreIn: person ? mine !== null : null,
    }
  }

  const env = async (ctx: AppActionContext): Promise<EngineEnv> => {
    const { db, projectKey } = host.open(ctx)
    return {
      db,
      projectKey,
      app: await host.appAddress(ctx),
      chats: host.chats(),
      spaceSlug: ctx.spaceSlug,
      ...(host.agents ? { agents: () => host.agents!(ctx) } : {}),
      now: host.now,
      inbox: host.inbox?.(ctx),
    }
  }

  const prepare = async (ctx: AppActionContext, draft: WorkflowDraft) => {
    const { db } = host.open(ctx)
    if (!draft || typeof draft !== 'object' || !Array.isArray(draft.steps)) {
      throw new Error('"workflow" is required: { name, description?, isDefault?, steps: [...] } — see workflow_get for the shape')
    }
    const statuses = statusList(db)
    const people = await host.people(ctx)
    const wf = normalizeDraft(draft, mintId, statuses, people)
    const others = listWorkflows(db).filter((w) => w.id !== wf.id).map((w) => w.name)
    const issues = validateWorkflow(wf, { statuses, otherNames: others, people })
    return { db, wf, issues }
  }

  const save = async (ctx: AppActionContext, draft: WorkflowDraft) => {
    const { db, wf, issues } = await prepare(ctx, draft)
    if (issues.length > 0) {
      throw new Error(`The workflow was not saved:\n${issues.map((i) => `- ${i.path}: ${i.message}`).join('\n')}`)
    }
    const saved = saveWorkflow(db, wf, host.now())
    host.changed(ctx, [])
    return saved
  }

  const runOf = (ctx: AppActionContext, key: string) => {
    const { db, projectKey } = host.open(ctx)
    const task = host.getTask(ctx, key)
    const taskId = (db.prepare('SELECT id FROM task WHERE number = ?').get(task.number) as { id: number }).id
    const run: WorkflowRun | null = activeRunForTask(db, projectKey, taskId)
    return { task, run, db, projectKey, taskId }
  }

  return {
    workflows_list: (ctx) => {
      const { db } = host.open(ctx)
      return { workflows: listWorkflows(db), statuses: statusList(db) }
    },

    workflow_get: (ctx, params) => requireWorkflow(host.open(ctx).db, params),

    space_chat: (ctx) => spaceChat(ctx),

    space_chat_grant: async (ctx) => {
      const person = host.personChats(ctx)
      if (!person) {
        throw new Error(
          `Only a person can let the task manager into this space's chat: in Settings → Chat, or in the chat's members dialog (add ${WORKFLOW_SYSTEM_MEMBER})`,
        )
      }
      const before = await spaceChat(ctx)
      if (!before.youAreIn) {
        throw new Error(
          `You aren't in this space's chat ("${before.slug}"), so you can't add the task manager to it: join the chat first, or ask one of its members`,
        )
      }
      await person.grantExtension(before.slug)
      return spaceChat(ctx)
    },

    workflow_validate: async (ctx, params) => {
      const { issues } = await prepare(ctx, params.workflow as WorkflowDraft)
      return { issues }
    },

    workflow_save: (ctx, params) => save(ctx, params.workflow as WorkflowDraft),

    workflow_step_update: (ctx, params) => {
      const { db } = host.open(ctx)
      const wf = requireWorkflow(db, params)
      const ref = str(params, 'step', 'the step name or id, from workflow_get')
      const index = wf.steps.findIndex((s) => s.id === ref || s.name.toLowerCase() === ref.toLowerCase())
      if (index < 0) {
        throw new Error(`No step "${ref}" in workflow "${wf.name}". Steps: ${wf.steps.map((s) => s.name).join(', ')}`)
      }
      const changes = Object.fromEntries(STEP_FIELDS.filter((f) => params[f] !== undefined).map((f) => [f, params[f]]))
      if (Object.keys(changes).length === 0) {
        throw new Error(`Nothing to change: pass at least one of ${STEP_FIELDS.join(', ')}`)
      }
      const steps = wf.steps.map((step, i) => (i === index ? { ...step, ...changes } : step))
      return save(ctx, { id: wf.id, name: wf.name, description: wf.description, isDefault: wf.isDefault, steps })
    },

    workflow_delete: (ctx, params) => {
      const { db } = host.open(ctx)
      const wf = requireWorkflow(db, params)
      deleteWorkflow(db, wf.id)
      host.changed(ctx, [])
      return { deleted: wf.id }
    },

    workflow_start: async (ctx, params) => {
      const key = str(params, 'task', 'the task key, e.g. TASK-12')
      const actor = host.actor(ctx)
      const task = host.getTask(ctx, key)
      const run = await startWorkflow(await env(ctx), host.tasks(ctx, actor), {
        task,
        workflow: optStr(params, 'workflow'),
        actor,
      })
      host.changed(ctx, [key])
      return run
    },

    workflow_run_get: async (ctx, params) => {
      const key = str(params, 'task', 'the task key, e.g. TASK-12')
      const { task, db, projectKey, taskId } = runOf(ctx, key)
      // Rounds whose finishing turn had not ended when they were recorded
      // settle now, if it has; the open round is read as of now.
      const chats = host.chats()
      await settlePendingUsage(
        db,
        chats,
        runsForTask(db, projectKey, taskId).map((r) => r.id),
      )
      const runs = runsForTask(db, projectKey, taskId)
      const active = runs.find((r) => r.state === 'active') ?? null
      const run = active ? await withLiveUsage(db, chats, active) : null
      const history = runs.filter((r) => r.id !== run?.id)
      const open = run?.steps.find((s) => s.state === 'active' || s.state === 'waiting')
      const workflow = run ? getWorkflow(db, run.workflowId) : null
      const step = open ? workflow?.steps.find((s) => s.id === open.stepId) : undefined
      return {
        task: { key: task.key, summary: task.summary, status: task.status.name },
        run,
        openStep:
          step && open && workflow
            ? {
                name: step.name,
                agent: open.agentName,
                transitions: step.transitions.map((t) => t.label),
                ...(step.approval ? { approval: openApproval(workflow, step, open, host.person(ctx)) } : {}),
              }
            : null,
        history,
        /** Across every run of the task: wall time of every round, and what its agent sessions spent. */
        spent: sumSpent([...(run ? [run.spent] : []), ...history.map((r) => r.spent)]),
      }
    },

    workflow_step_finish: async (ctx, params) => {
      const key = str(params, 'task', 'the task key, e.g. TASK-12')
      const transition = params.transition
      if ((typeof transition !== 'string' || !transition.trim()) && typeof transition !== 'number') {
        throw new Error('"transition" is required: the label of one of the open step\'s transitions (workflow_run_get lists them)')
      }
      const actor = host.actor(ctx)
      const run = await finishStep(await env(ctx), host.tasks(ctx, actor), {
        task: host.getTask(ctx, key),
        transition,
        summary: optStr(params, 'summary'),
        actor,
      })
      host.changed(ctx, [key])
      return run
    },

    workflow_step_decide: async (ctx, params) => {
      const key = str(params, 'task', 'the task key, e.g. TASK-12')
      const verdict = str(params, 'verdict', `one of ${APPROVAL_VERDICTS.join(', ')}`) as ApprovalVerdict
      if (!APPROVAL_VERDICTS.includes(verdict)) {
        throw new Error(`"verdict" must be one of: ${APPROVAL_VERDICTS.join(', ')}`)
      }
      const run = await decideStep(await env(ctx), host.tasks(ctx, host.actor(ctx)), {
        task: host.getTask(ctx, key),
        verdict,
        transition: optStr(params, 'transition'),
        comment: optStr(params, 'comment'),
        person: host.person(ctx),
      })
      host.changed(ctx, [key])
      return run
    },

    workflow_step_restart: async (ctx, params) => {
      const key = str(params, 'task', 'the task key, e.g. TASK-12')
      const step = str(params, 'step', 'the step name or id, from workflow_run_get')
      const actor = host.actor(ctx)
      const run = await restartStep(await env(ctx), host.tasks(ctx, actor), { task: host.getTask(ctx, key), step, actor })
      host.changed(ctx, [key])
      return run
    },

    workflow_run_cancel: async (ctx, params) => {
      const key = str(params, 'task', 'the task key, e.g. TASK-12')
      const run = await cancelRun(await env(ctx), { task: host.getTask(ctx, key), actor: host.actor(ctx) })
      host.changed(ctx, [key])
      return run
    },

    workflow_runs_list: (ctx, params) => {
      const { db, projectKey } = host.open(ctx)
      const state = optStr(params, 'state') as RunState | undefined
      if (state && !['active', 'finished', 'cancelled'].includes(state)) {
        throw new Error('"state" must be one of: active, finished, cancelled')
      }
      const workflow = optStr(params, 'workflow') ? requireWorkflow(db, params) : undefined
      const limit = typeof params.limit === 'number' ? params.limit : undefined
      if (params.match === undefined) {
        return { runs: listRuns(db, projectKey, { state, workflowId: workflow?.id, limit }) }
      }
      if (!workflow) {
        throw new Error('"match" needs "workflow": it selects runs by that workflow\'s steps')
      }
      // `total` counts every matching run; `runs` stops at the limit, so a caller can say it shows fewer.
      const ids = matchingRunIds(db, workflow.id, runsMatch(params.match, workflow), host.now())
      return { runs: listRuns(db, projectKey, { workflowId: workflow.id, limit, ids }), total: ids.length }
    },

    workflow_stats: async (ctx, params) => {
      const { db } = host.open(ctx)
      const range = (optStr(params, 'range') ?? '30d') as StatsRange
      if (!STATS_RANGES.includes(range)) {
        throw new Error(`"range" must be one of: ${STATS_RANGES.join(', ')}`)
      }
      const workflow = requireWorkflow(db, params)
      const now = host.now()
      await settlePendingUsage(db, host.chats(), pendingRunIds(db, workflow.id, rangeStart(range, now)))
      return workflowStats(db, workflow, range, now)
    },
  }
}
