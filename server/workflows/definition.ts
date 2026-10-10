/**
 * Workflow definitions: normalising what a caller submits, and deciding
 * whether it can be saved.
 *
 * Validation runs on the whole draft and returns every issue at once, each
 * with the path of the field it belongs to, so the step editor can mark all
 * of them in one pass and an agent calling `workflow_save` learns everything
 * wrong from one refusal. Nothing here touches storage or the host; what it
 * needs to know about the world (statuses, other names) is handed in.
 *
 * Which chat a step's session opens in is not part of a definition: it is
 * always the space's chat, and whether the step's agent is in it is known only
 * when the step opens (the chat's members change without the workflow). A step
 * may name the folder of that chat's thread list its thread is filed in.
 */

import type { StatusRef } from '../../shared/types.ts'
import {
  APPROVAL_VERDICTS,
  DEFAULT_STEP_INSTRUCTIONS,
  defaultTransitionLabel,
  derivedGate,
  STEP_EFFORTS,
  STEP_KINDS,
  STEP_PERMISSION_MODES,
  STEP_PRESENCE_KINDS,
  type StepApproval,
  type StepApprovalDraft,
  type StepApprover,
  type StepKind,
  type StepPresence,
  type StepSessionOptions,
  type StepWorker,
  stepStartedBy,
  TRANSITION_GATES,
  type TransitionGate,
  type ValidationIssue,
  VERDICT_GATE,
  verdictTransitions,
  type WorkflowDraft,
  type WorkflowStepDef,
  type WorkflowTransition,
  type WorkflowTransitionDraft,
} from '../../shared/workflows.ts'
import { placeholderProblem, placeholders, stepSlug } from './template.ts'

export const NAME_MAX = 80
export const STEP_NAME_MAX = 60
export const DESCRIPTION_MAX = 2000
export const INSTRUCTIONS_MAX = 20_000
export const FOLDER_MAX = 80
export const TRANSITION_LABEL_MAX = 80

export interface ValidationEnv {
  statuses: ReadonlyArray<{ id: number; name: string }>
  /** Names of the project's OTHER workflows — the one being saved excluded. */
  otherNames: ReadonlyArray<string>
  /** The host's directory of people: the only ones who can approve. */
  people: ReadonlyArray<{ id: string; name: string }>
}

export interface NormalizedWorkflow {
  id: string
  name: string
  description: string
  isDefault: boolean
  steps: WorkflowStepDef[]
}

function normalizeWorker(worker: StepWorker | undefined): StepWorker {
  if (worker?.kind === 'agent') {
    return { kind: 'agent', agentNodeId: String(worker.agentNodeId ?? '').trim() }
  }
  return { kind: 'assignee' }
}

/**
 * The options a step sets, each kept only when given: absent, null or blank
 * is "not set". A presence keeps only the fields its kind has. Values are
 * judged by validation, not here.
 */
function normalizeSessionOptions(options: StepSessionOptions | null | undefined): StepSessionOptions {
  const out: StepSessionOptions = {}
  const effort = String(options?.effort ?? '').trim()
  if (effort) {
    out.effort = effort as StepSessionOptions['effort']
  }
  const permissionMode = String(options?.permissionMode ?? '').trim()
  if (permissionMode) {
    out.permissionMode = permissionMode as StepSessionOptions['permissionMode']
  }
  const presence = options?.presence
  if (presence) {
    out.presence = (
      presence.kind === 'custom' ? { kind: 'custom', intervalMs: Number(presence.intervalMs) } : { kind: presence.kind }
    ) as StepPresence
  }
  const compactAbove = options?.compactAbove
  if (compactAbove !== undefined && compactAbove !== null && String(compactAbove).trim() !== '') {
    out.compactAbove = Number(compactAbove)
  }
  return out
}

const MINUTE_MS = 60_000

function sessionOptionIssues(options: StepSessionOptions, issue: (field: string, message: string) => void): void {
  if (options.effort !== undefined && !(STEP_EFFORTS as readonly string[]).includes(options.effort)) {
    issue('effort', `No effort "${options.effort}". Efforts: ${STEP_EFFORTS.join(', ')}`)
  }
  if (
    options.permissionMode !== undefined &&
    !(STEP_PERMISSION_MODES as readonly string[]).includes(options.permissionMode)
  ) {
    issue(
      'permissionMode',
      `No permission mode "${options.permissionMode}". Modes: ${STEP_PERMISSION_MODES.join(', ')}`,
    )
  }
  if (options.compactAbove !== undefined && !(Number.isInteger(options.compactAbove) && options.compactAbove >= 0)) {
    issue('compactAbove', 'Compact above is a whole number of tokens: 0 never compacts, empty takes the default')
  }
  const presence = options.presence
  if (presence === undefined) {
    return
  }
  if (!(STEP_PRESENCE_KINDS as readonly string[]).includes(presence.kind)) {
    issue('presence', `No presence "${presence.kind}". Presences: ${STEP_PRESENCE_KINDS.join(', ')}`)
  } else if (
    presence.kind === 'custom' &&
    !(
      Number.isInteger(presence.intervalMs) &&
      presence.intervalMs >= MINUTE_MS &&
      presence.intervalMs % MINUTE_MS === 0
    )
  ) {
    issue(
      'presence',
      'A custom presence reads every whole number of minutes: give intervalMs as minutes × 60000, at least 60000',
    )
  }
}

/**
 * A status given by id or by name (case-insensitive) as its id. Blank is 0, which validation asks
 * the caller to fill in; an unknown one is NaN, which validation reports with the valid names.
 */
function statusId(statuses: ValidationEnv['statuses'], ref: StatusRef | null | undefined): number {
  if (typeof ref === 'number') {
    return ref
  }
  const text = String(ref ?? '').trim()
  if (!text) {
    return 0
  }
  if (/^\d+$/.test(text)) {
    return Number(text)
  }
  return statuses.find((s) => s.name.toLowerCase() === text.toLowerCase())?.id ?? Number.NaN
}

/** What `toStep` holds for a step reference that names no step of the workflow; validation reports it. */
const UNKNOWN_STEP = '\u0000unknown'

/**
 * A transition's target: a step by id or name (case-insensitive), the end for
 * null or "end", and when omitted the first step its status starts (the end
 * when none does) — the rule a bare status follows too.
 */
function targetStep(
  steps: ReadonlyArray<Pick<WorkflowStepDef, 'id' | 'name' | 'triggerStatus'>>,
  ref: string | null | undefined,
  status: number,
): string | null {
  if (ref === undefined) {
    return stepStartedBy(steps, status)?.id ?? null
  }
  const text = String(ref ?? '').trim()
  if (!text || text.toLowerCase() === 'end') {
    return null
  }
  return (
    (steps.find((s) => s.id === text) ?? steps.find((s) => s.name.toLowerCase() === text.toLowerCase()))?.id ??
    UNKNOWN_STEP
  )
}

/**
 * An approval step's approvers: each by directory id, or by name when no id is
 * given (case-insensitive, and only when exactly one person has it). One that
 * resolves to nobody keeps an empty id, which validation reports by its name.
 */
function normalizeApproval(draft: StepApprovalDraft | null | undefined, people: ValidationEnv['people']): StepApproval {
  const approvers = (draft?.approvers ?? []).map((a): StepApprover => {
    const id = String(a.personId ?? '').trim()
    const name = String(a.name ?? '').trim()
    const byName = people.filter((p) => p.name.trim().toLowerCase() === name.toLowerCase())
    const person = id ? people.find((p) => p.id === id) : byName.length === 1 ? byName[0] : undefined
    return { personId: id || person?.id || '', name: person?.name ?? (name || id), required: a.required === true }
  })
  const needed = draft?.needed ?? Math.max(1, approvers.filter((a) => a.required).length)
  return { approvers, needed: Number(needed) }
}

function approvalIssues(
  approval: StepApproval,
  people: ValidationEnv['people'],
  issue: (field: string, message: string) => void,
): void {
  const { approvers, needed } = approval
  if (approvers.length === 0) {
    issue('approval.approvers', 'Add at least one approver')
  }
  const seen = new Set<string>()
  approvers.forEach((a, i) => {
    if (!a.personId || !people.some((p) => p.id === a.personId)) {
      issue(`approval.approvers.${i}`, `"${a.name}" is not a person in the directory: only people can approve`)
    } else if (seen.has(a.personId)) {
      issue(`approval.approvers.${i}`, `${a.name} is already an approver of this step`)
    }
    seen.add(a.personId)
  })
  const required = approvers.filter((a) => a.required).length
  if (
    approvers.length > 0 &&
    (!Number.isInteger(needed) || needed < Math.max(1, required) || needed > approvers.length)
  ) {
    issue(
      'approval.needed',
      `Approvals needed must be a whole number from ${Math.max(1, required)} (the required approvers, at least 1) to ${approvers.length} (every approver)`,
    )
  }
}

function normalizeGate(gate: unknown): TransitionGate | null {
  const text = String(gate ?? '').trim()
  return text ? (text as TransitionGate) : null
}

/**
 * Trim every string, mint missing ids, resolve status and step references, label unlabelled
 * transitions, and give a step without instructions the default ones. Does not judge validity.
 */
export function normalizeDraft(
  draft: WorkflowDraft,
  mintId: () => string,
  statuses: ValidationEnv['statuses'],
  /** What an approver given by name is resolved against. */
  people: ValidationEnv['people'] = [],
): NormalizedWorkflow {
  const status = (ref: StatusRef | null | undefined) => statusId(statuses, ref)
  const statusName = (id: number) => statuses.find((s) => s.id === id)?.name ?? `#${id}`
  const drafts = draft.steps ?? []
  const steps = drafts.map((step) => ({
    id: step.id?.trim() || mintId(),
    name: String(step.name ?? '').trim(),
    triggerStatus: status(step.triggerStatus),
  }))
  return {
    id: draft.id?.trim() || mintId(),
    name: String(draft.name ?? '').trim(),
    description: String(draft.description ?? '').trim(),
    isDefault: draft.isDefault === true,
    steps: drafts.map((step, i) => {
      const self = steps[i]
      const bare = new Set<number>()
      const entries = (step.transitions ?? []).flatMap((entry): WorkflowTransitionDraft[] => {
        if (typeof entry === 'object' && entry !== null) {
          return [entry]
        }
        // A status named twice is one transition.
        const id = status(entry)
        if (bare.has(id)) {
          return []
        }
        bare.add(id)
        return [{ status: id }]
      })
      const transitions = entries.map((t): WorkflowTransition => {
        const to = status(t.status)
        const toStep = targetStep(steps, t.toStep, to)
        const gate = normalizeGate(t.gate)
        const target = steps.find((s) => s.id === toStep)
        return {
          id: t.id?.trim() || mintId(),
          label:
            String(t.label ?? '').trim() ||
            defaultTransitionLabel(
              gate ?? derivedGate(steps, self.id, toStep),
              target ? { step: target.name } : { endStatus: statusName(to) },
            ),
          toStep,
          status: to,
          gate,
        }
      })
      if (step.kind === 'approval') {
        // Nothing of a session applies: no worker, message, folder or options.
        return {
          ...self,
          kind: 'approval',
          approval: normalizeApproval(step.approval, people),
          worker: { kind: 'assignee' },
          instructions: '',
          transitions,
          folder: '',
          sessionOptions: {},
        }
      }
      return {
        ...self,
        kind: (step.kind === undefined ? 'agent' : String(step.kind)) as StepKind,
        approval: null,
        worker: normalizeWorker(step.worker),
        instructions: String(step.instructions ?? DEFAULT_STEP_INSTRUCTIONS).replace(/\s+$/, ''),
        transitions,
        folder: String(step.folder ?? '').trim(),
        sessionOptions: normalizeSessionOptions(step.sessionOptions),
      }
    }),
  }
}

export function validateWorkflow(workflow: NormalizedWorkflow, env: ValidationEnv): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const issue = (path: string, message: string) => issues.push({ path, message })
  const statusIds = new Set(env.statuses.map((s) => s.id))
  const unknownStatus = `No such status. Statuses (name or id): ${env.statuses.map((s) => `${s.name} (${s.id})`).join(', ')}`

  if (!workflow.name) {
    issue('name', 'A workflow needs a name')
  } else if (workflow.name.length > NAME_MAX) {
    issue('name', `Keep the name under ${NAME_MAX} characters`)
  } else if (env.otherNames.some((n) => n.trim().toLowerCase() === workflow.name.toLowerCase())) {
    issue('name', `Another workflow is already called "${workflow.name}"`)
  }
  if (workflow.description.length > DESCRIPTION_MAX) {
    issue('description', `Keep the description under ${DESCRIPTION_MAX} characters`)
  }
  if (workflow.steps.length === 0) {
    issue('steps', 'A workflow needs at least one step')
  }

  const slugs = new Map<string, number>()
  const stepIds = new Set<string>()
  const transitionIds = new Set<string>()
  const allStepIds = new Set(workflow.steps.map((s) => s.id))
  workflow.steps.forEach((step, i) => {
    const at = (field: string) => `steps.${i}.${field}`
    if (stepIds.has(step.id)) {
      issue(`steps.${i}`, 'Two steps share one id')
    }
    stepIds.add(step.id)

    const slug = stepSlug(step.name)
    if (!step.name) {
      issue(at('name'), 'A step needs a name')
    } else if (step.name.length > STEP_NAME_MAX) {
      issue(at('name'), `Keep step names under ${STEP_NAME_MAX} characters`)
    } else if (!slug) {
      issue(at('name'), 'A step name needs at least one letter or digit')
    } else if (slugs.has(slug)) {
      issue(at('name'), `Step ${(slugs.get(slug) ?? 0) + 1} already has this name`)
    }

    if (step.triggerStatus === 0) {
      issue(at('triggerStatus'), 'Choose the status that starts this step')
    } else if (!statusIds.has(step.triggerStatus)) {
      issue(at('triggerStatus'), unknownStatus)
    }

    if (!STEP_KINDS.includes(step.kind)) {
      issue(at('kind'), `No step kind "${step.kind}". Kinds: ${STEP_KINDS.join(', ')}`)
    }
    if (step.approval) {
      approvalIssues(step.approval, env.people, (field, message) => issue(at(field), message))
      const byVerdict = verdictTransitions(workflow.steps, step)
      for (const verdict of APPROVAL_VERDICTS) {
        if (step.transitions.length > 0 && byVerdict[verdict].length === 0) {
          issue(
            at('transitions'),
            `Give the step a transition with a ${VERDICT_GATE[verdict]} gate for its approvers to ${verdict} by`,
          )
        }
      }
    } else if (step.worker.kind === 'agent' && !step.worker.agentNodeId) {
      issue(at('worker'), 'Choose the agent that works this step')
    }

    if (step.instructions.length > INSTRUCTIONS_MAX) {
      issue(at('instructions'), `Keep instructions under ${INSTRUCTIONS_MAX} characters`)
    }
    for (const { path } of placeholders(step.instructions)) {
      const problem = placeholderProblem(path, new Set(slugs.keys()))
      if (problem) {
        issue(at('instructions'), problem)
      }
    }

    if (step.folder.length > FOLDER_MAX) {
      issue(at('folder'), `Keep the folder name under ${FOLDER_MAX} characters`)
    }

    sessionOptionIssues(step.sessionOptions, (field, message) => issue(at(`sessionOptions.${field}`), message))

    if (step.transitions.length === 0) {
      issue(at('transitions'), 'Give the step at least one transition its agent can finish it by')
    }
    const labels = new Map<string, number>()
    step.transitions.forEach((t, j) => {
      const tat = (field: string) => `${at('transitions')}.${j}.${field}`
      if (transitionIds.has(t.id)) {
        issue(`${at('transitions')}.${j}`, 'Two transitions share one id')
      }
      transitionIds.add(t.id)
      const label = t.label.toLowerCase()
      if (t.label.length > TRANSITION_LABEL_MAX) {
        issue(tat('label'), `Keep transition labels under ${TRANSITION_LABEL_MAX} characters`)
      } else if (labels.has(label)) {
        issue(tat('label'), `Transition ${(labels.get(label) ?? 0) + 1} of this step already has this label`)
      } else {
        labels.set(label, j)
      }
      if (t.status === 0) {
        issue(tat('status'), 'Choose the status the transition moves the task to')
      } else if (!statusIds.has(t.status)) {
        issue(tat('status'), unknownStatus)
      }
      if (t.toStep === step.id) {
        issue(tat('toStep'), `A transition can't lead back into "${step.name}" itself`)
      } else if (t.toStep !== null && !allStepIds.has(t.toStep)) {
        issue(tat('toStep'), `No such step. Steps: ${workflow.steps.map((s) => `"${s.name}"`).join(', ')}, or "end"`)
      }
      if (t.gate !== null && !TRANSITION_GATES.includes(t.gate)) {
        issue(tat('gate'), `No gate "${t.gate}". Gates: ${TRANSITION_GATES.join(', ')}, or null to derive it`)
      }
    })

    if (slug && !slugs.has(slug)) {
      slugs.set(slug, i)
    }
  })
  return issues
}
