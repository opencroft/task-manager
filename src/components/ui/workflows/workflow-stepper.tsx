import { AlertTriangle, Check, Circle, Loader2, X } from "lucide-react"
import type { ReactNode } from "react"

import { ScrollArea } from "@/components/ui/layout/scroll-area"
import { cn } from "cn"

export type WorkflowStepState = "pending" | "active" | "waiting" | "done"

export type WorkflowStepperOrientation = "horizontal" | "vertical"

const STATE_LABEL: Record<WorkflowStepState, string> = {
  pending: "Not reached",
  active: "Working",
  waiting: "Needs attention",
  done: "Done",
}

const STATE_TONE: Record<WorkflowStepState, string> = {
  pending: "text-muted-foreground",
  active: "text-blue-600 dark:text-blue-400",
  waiting: "text-amber-600 dark:text-amber-400",
  done: "text-emerald-600 dark:text-emerald-400",
}

/**
 * A gate result: whether a step's round let the task move on (`pass`) or sent
 * it back (`fail`), from the transition the round left by.
 */
export type WorkflowGate = "pass" | "fail"

const GATE_LABEL: Record<WorkflowGate, string> = {
  pass: "Passed",
  fail: "Sent back",
}

const GATE_TONE: Record<WorkflowGate, string> = {
  pass: "text-emerald-600 dark:text-emerald-400",
  fail: "text-rose-600 dark:text-rose-400",
}

/** A step's gate result: its last round's, once the step is done; null before, or when that round took no transition. */
export function workflowStepGate(step: { state: WorkflowStepState; rounds?: ReadonlyArray<{ gate?: WorkflowGate | null }> }): WorkflowGate | null {
  return step.state === "done" ? (step.rounds?.at(-1)?.gate ?? null) : null
}

/** A step's state in words; a done step with a gate result says that instead. */
export function workflowStepStateLabel(state: WorkflowStepState, gate?: WorkflowGate | null): string {
  return state === "done" && gate ? GATE_LABEL[gate] : STATE_LABEL[state]
}

/** A gate result as an icon: a check for passed, a cross for sent back. */
export function WorkflowGateIcon({ gate, className }: { gate: WorkflowGate; className?: string }) {
  const Icon = gate === "pass" ? Check : X
  return <Icon aria-label={GATE_LABEL[gate]} className={cn("size-4 shrink-0", GATE_TONE[gate], className)} />
}

/**
 * A step's state as an icon: an empty ring, a working spinner, a warning, or
 * for a done step its last round's gate (a check, or a cross when it sent the
 * task back). A done step with no gate result is a check.
 */
export function WorkflowStepStateIcon({ state, gate, className }: { state: WorkflowStepState; gate?: WorkflowGate | null; className?: string }) {
  if (state === "done" && gate) {
    return <WorkflowGateIcon gate={gate} className={className} />
  }
  const Icon = state === "done" ? Check : state === "active" ? Loader2 : state === "waiting" ? AlertTriangle : Circle
  return (
    <Icon
      aria-label={STATE_LABEL[state]}
      className={cn("size-4 shrink-0", STATE_TONE[state], state === "active" && "animate-spin [animation-duration:2.5s]", className)}
    />
  )
}

export interface WorkflowStepperItem {
  id: string
  name: string
  state: WorkflowStepState
  /** A second line: the agent, or why it is waiting. */
  detail?: ReactNode
  /** Rounds worked, when more than one. */
  attempts?: number
  /** A done step's last round's gate result; the icon and label follow it. */
  gate?: WorkflowGate | null
}

export interface WorkflowStepperProps {
  steps: WorkflowStepperItem[]
  /** The step shown below the stepper; pressing another selects it. */
  selectedId: string | null
  onSelect: (id: string) => void
  /** Wraps each step, e.g. to give it a context menu. Receives the step and its rendered button. */
  renderStep?: (step: WorkflowStepperItem, button: ReactNode) => ReactNode
  /** A row that scrolls sideways (the default), or a column, for a narrow side panel. */
  orientation?: WorkflowStepperOrientation
  className?: string
}

/**
 * A run's steps in order, each a pressable chip with its state, joined by a
 * line that fills in as the run moves. In a row it scrolls sideways when the
 * steps do not fit, rather than squeezing their names.
 */
export function WorkflowStepper({ steps, selectedId, onSelect, renderStep, orientation = "horizontal", className }: WorkflowStepperProps) {
  const vertical = orientation === "vertical"
  const list = (
    <ol
      data-slot="workflow-stepper"
      data-orientation={orientation}
      className={cn(vertical ? "flex flex-col items-stretch" : "flex items-stretch gap-0 pb-3", className)}
      aria-label="Workflow steps"
    >
      {steps.map((step, index) => {
        const selected = step.id === selectedId
        const button = (
          <button
            type="button"
            aria-current={selected ? "step" : undefined}
            onClick={() => onSelect(step.id)}
            className={cn(
              "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              vertical ? "w-full min-w-0" : "min-w-36 max-w-56",
              selected ? "border-primary/60 bg-primary/5" : "border-border hover:bg-muted/60",
            )}
          >
            <span className="flex w-full min-w-0 items-center gap-1.5 text-sm font-medium">
              <WorkflowStepStateIcon state={step.state} gate={step.gate} />
              <span className="truncate">{step.name}</span>
              {step.attempts && step.attempts > 1 ? (
                <span className="ml-auto inline-flex h-5 shrink-0 items-center rounded-md bg-muted px-1.5 text-[11px] font-medium text-muted-foreground">
                  ×{step.attempts}
                  <span className="sr-only">, round {step.attempts}</span>
                </span>
              ) : null}
            </span>
            <span className="w-full truncate text-xs text-muted-foreground">{step.detail ?? workflowStepStateLabel(step.state, step.gate)}</span>
          </button>
        )
        const joined = steps[index - 1]?.state === "done" ? "bg-emerald-500/60" : "bg-border"
        return (
          <li key={step.id} className={vertical ? "flex min-w-0 flex-col" : "flex items-center"}>
            {index > 0 ? (
              <span aria-hidden="true" className={cn("shrink-0", vertical ? "ml-5 h-3 w-px" : "h-px w-4 sm:w-6", joined)} />
            ) : null}
            {renderStep ? renderStep(step, button) : button}
          </li>
        )
      })}
    </ol>
  )
  // A row scrolls sideways under the kit's bar, which sits in the row's bottom padding.
  return vertical ? list : <ScrollArea scrollbars="horizontal">{list}</ScrollArea>
}
