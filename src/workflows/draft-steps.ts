// A workflow's steps as the Workflows page edits them: each step keyed for
// React and holding an id from the start, so a transition can lead to a step
// that has not been saved yet.

import type { WorkflowStepCardValue } from '../components/ui/workflows/workflow-step-card'

export interface DraftStep extends WorkflowStepCardValue {
  /** The step's id: the stored one, or one minted here for a new step. */
  id: string
  /** A stable React key. */
  key: string
}

export type DraftTransition = WorkflowStepCardValue['transitions'][number]

let keySeq = 0
export const nextKey = () => `key-${++keySeq}`
export const newStepId = () => crypto.randomUUID()

/** An approval with nobody on it yet: what an agent step holds, so switching it to an approval step starts empty. */
export const noApproval = (): WorkflowStepCardValue['approval'] => ({ approvers: [], needed: 1 })

/** A transition as the editor holds it, keyed for the list. */
export function draftTransition(t: Omit<DraftTransition, 'key'>): DraftTransition {
  return { ...t, key: nextKey() }
}

/**
 * A copy of steps under new ids: transitions between the copied steps follow
 * them, and every transition is a new one.
 */
export function copySteps(steps: DraftStep[]): DraftStep[] {
  const ids = new Map(steps.map((s) => [s.id, newStepId()]))
  return steps.map((s) => ({
    ...s,
    id: ids.get(s.id) ?? newStepId(),
    key: nextKey(),
    transitions: s.transitions.map(({ id: _id, ...t }) =>
      draftTransition({ ...t, toStep: t.toStep === null ? null : (ids.get(t.toStep) ?? t.toStep) }),
    ),
  }))
}

/**
 * The steps with a copy of one inserted after it, named "<name> copy". The
 * copy keeps everything the step sets, its trigger status included, since
 * steps may share one; its transitions lead where the original's do.
 */
export function duplicateStep(steps: DraftStep[], index: number): DraftStep[] {
  const step = steps[index]
  if (!step) {
    return steps
  }
  const [copy] = copySteps([step])
  return [...steps.slice(0, index + 1), { ...copy, name: `${step.name} copy` }, ...steps.slice(index + 1)]
}
