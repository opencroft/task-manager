import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  MessagesSquare,
  Play,
  RotateCcw,
  Shrink,
  Square,
  Workflow as WorkflowIcon,
} from "lucide-react"
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"

import { Button } from "../button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../dropdown-menu"
import { Skeleton } from "../skeleton"
import { formatCompactNumber } from "../utils/compact-number"
import { cn } from "cn"
import { ItemActionsMenu, ItemContextMenu, type ItemMenuEntries, MENU_SCROLL_POPUP, MenuScrollArea } from "../tasks/item-menu"

import { WorkflowSpent, type WorkflowSpentUsage, type WorkflowSpentValue } from "./workflow-spent"
import {
  type WorkflowGate,
  WorkflowGateIcon,
  type WorkflowStepperItem,
  type WorkflowStepperOrientation,
  type WorkflowStepState,
  WorkflowStepper,
  workflowStepGate,
  workflowStepStateLabel,
} from "./workflow-stepper"

/** The step fields the panel reads, named as a run step carries them, so a run step passes in as it is. */
export interface WorkflowRunPanelStep {
  stepId: string
  name: string
  state: WorkflowStepState
  agentName: string | null
  chatRef: string | null
  chatSlug: string | null
  threadId: string | null
  startedAt: string | null
  endedAt: string | null
  outcome: string | null
  summary: string | null
  finishedBy: string | null
  attempts: number
  error: string | null
  /** Each entry into the step, oldest first; listed with each one's gate result, time and usage once one has a gate result or there are several. */
  rounds?: WorkflowRunPanelRound[]
  /** The step's rounds summed: wall time, and what its agent session spent. */
  spent?: WorkflowSpentValue
}

/** One entry into a step, as a run round carries it. */
export interface WorkflowRunPanelRound {
  roundNo: number
  worker: { kind: "agent" | "person"; name: string } | null
  timeMs: number
  /** ISO 8601; null while the round is open. */
  endedAt?: string | null
  /**
   * `live`: the round is open and read as of now; `pending`: its finishing turn
   * is still running; `shared`: it happened inside a turn the round of step
   * `sharedWith` counted, so it has no figures of its own.
   */
  usage: (WorkflowSpentUsage & { state: "settled" | "pending" | "live" | "shared"; sharedWith?: string }) | null
  /** The label of the step's transition the round left by; null while open, or when no transition was taken. */
  transition?: string | null
  /** That transition's gate result: the task moved on, or was sent back. */
  gate?: WorkflowGate | null
  /** An approval step's decisions in the round, oldest first. */
  decisions?: WorkflowRunPanelDecision[]
  /** Context tokens the round's session held when the round ended, or now while it is open. */
  contextTokens?: number | null
  /** The compaction of the session before the round's message, when there was one. */
  compaction?: WorkflowRunPanelCompaction | null
}

/**
 * A compaction of a step's session before a round's message. `running` until it ends; the message is
 * sent after it whichever way it ends, unless `unsent` says otherwise. `not_compacted`: the context did
 * not shrink; `unknown`: there was no reading to tell by; `timed_out`: it had not ended when the wait
 * for it gave up.
 */
export interface WorkflowRunPanelCompaction {
  outcome: "running" | "compacted" | "not_compacted" | "unknown" | "failed" | "timed_out"
  /** The step's threshold the session's context was over, in tokens. */
  threshold: number
  before: number | null
  after: number | null
  error: string | null
  /** The round's message was not sent after it, e.g. a restart cut the compaction off; restarting the step sends it. */
  unsent?: boolean
}

/** One approver's decision in a round of an approval step. */
export interface WorkflowRunPanelDecision {
  approver: { name: string }
  verdict: "approve" | "reject"
  /** The label of the transition they chose. */
  transition: string
  comment: string | null
  /** ISO 8601. */
  at: string
}

/** The run fields the panel reads, named as a workflow run carries them. */
export interface WorkflowRunPanelRun<S extends WorkflowRunPanelStep = WorkflowRunPanelStep> {
  workflowName: string
  state: "active" | "finished" | "cancelled"
  startedBy: { name: string }
  startedAt: string
  /** When the run finished or was cancelled; null while it is active. */
  endedAt: string | null
  steps: S[]
}

export interface WorkflowRunPanelWorkflow {
  id: string
  name: string
  isDefault: boolean
}

/** Which action is in flight, so its button spins and the others wait. */
export type WorkflowRunPanelBusy = "start" | "cancel" | "restart" | "finish" | null

export interface WorkflowRunPanelProps<R extends WorkflowRunPanelRun> {
  /**
   * The run to show: the active one, else the latest that ended, so a finished
   * run's steps and sessions stay readable. null when the task has never run one.
   */
  run: R | null
  /** Earlier runs on the task, newest first, without the one shown. */
  history?: Array<Pick<R, "workflowName" | "state" | "startedAt">>
  /** What the task has cost across all its runs; shown under the steps. */
  spent?: WorkflowSpentValue
  /** The project's workflows, offered by the start control. */
  workflows: WorkflowRunPanelWorkflow[]
  /** Shows the loading state. */
  loading?: boolean
  /** Labels of the open step's transitions, in the order offered: what Advance finishes it by. Leave empty for an approval step, which its approvers decide. */
  openTransitions?: string[]
  /**
   * The open step is an approval step: what to show in its place of a session, usually the approval bar.
   * The step then reads as awaiting approval rather than needing attention.
   */
  approval?: ReactNode
  busy?: WorkflowRunPanelBusy
  /** The selected step. Leave it out and the panel picks the open step, else the last one that ran, and follows the run. */
  selectedStepId?: string | null
  onSelectStep?: (stepId: string) => void
  onStart: (workflowId: string) => void
  onCancel: () => void
  /** On the open step, re-enters its session; on another step, moves the task back to that step. */
  onRestart: (step: R["steps"][number]) => void
  /** Finishes the open step by one of `openTransitions`, by its label. */
  onFinish: (transition: string) => void
  /** The host's page for a step's session, or null when it has none. */
  sessionHref?: (step: R["steps"][number]) => string | null
  /**
   * Opens a step's session where the host shows its chat, e.g. the chat panel beside the page.
   * Offered only for a step that has a thread; without it, a step's session is reached through `sessionHref`.
   */
  onOpenSession?: (step: R["steps"][number]) => void
  /** Renders a finished step's summary (the host's markdown). Plain text when not given. */
  renderSummary?: (summary: string, step: R["steps"][number]) => ReactNode
  /** Where "Create one" goes when the project has no workflows. */
  createWorkflowHref?: string
  /** The stepper's direction. `auto`: vertical when the panel is phone-narrow, horizontal otherwise. */
  orientation?: WorkflowStepperOrientation | "auto"
  className?: string
}

/**
 * Below this width the panel takes its phone layout. It is Tailwind's `sm`
 * breakpoint, where the rest of the app changes layout too, measured on the
 * panel rather than the window so a narrow side panel counts as well.
 */
const PHONE_WIDTH = 640

function formatStamp(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"
}

const AWAITING_APPROVAL = "Awaiting approval"

const isOpenStep = (step: WorkflowRunPanelStep) => step.state === "active" || step.state === "waiting"

/** `approvalOpen`: the open step is an approval step, which waits on its approvers rather than needing attention. */
function stepperItems(steps: WorkflowRunPanelStep[], approvalOpen: boolean): WorkflowStepperItem[] {
  return steps.map((step) => ({
    id: step.stepId,
    name: step.name,
    state: step.state,
    gate: workflowStepGate(step),
    attempts: step.attempts,
    detail:
      step.state === "waiting" ? (approvalOpen ? AWAITING_APPROVAL : "Needs attention") : (step.agentName ?? undefined),
  }))
}

/** The step to show first: the open one, else the last one that ran, else the first. */
function initialStep(steps: WorkflowRunPanelStep[]): string | null {
  const open = steps.find((s) => s.state === "active" || s.state === "waiting")
  const lastRun = [...steps].reverse().find((s) => s.state === "done")
  return (open ?? lastRun ?? steps[0])?.stepId ?? null
}

function PanelHeading({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <WorkflowIcon className="size-4 shrink-0 text-muted-foreground" />
      <h2 className="shrink-0 text-sm font-semibold">Workflow</h2>
      {children}
    </div>
  )
}

function StartWorkflow({
  workflows,
  busy,
  compact = false,
  onStart,
  createWorkflowHref,
}: {
  workflows: WorkflowRunPanelWorkflow[]
  busy: boolean
  /** Just the controls, for the header of an ended run: no frame, no status line, "Run again". */
  compact?: boolean
  onStart: (workflowId: string) => void
  createWorkflowHref?: string
}) {
  const fallback = workflows.find((w) => w.isDefault) ?? workflows[0]
  const [choice, setChoice] = useState<string | null>(fallback?.id ?? null)
  const chosen = workflows.find((w) => w.id === choice) ?? fallback
  if (!chosen) {
    if (compact) {
      return null
    }
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
        No workflows in this project yet.
        {createWorkflowHref ? (
          <a href={createWorkflowHref} className="rounded-sm text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
            Create one
          </a>
        ) : null}
      </div>
    )
  }
  const controls = (
      <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
        {workflows.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="min-w-0" />}>
              <span className="truncate">{chosen.name}</span>
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={MENU_SCROLL_POPUP}>
              <MenuScrollArea>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Workflow</DropdownMenuLabel>
                  {workflows.map((w) => (
                    <DropdownMenuItem key={w.id} onClick={() => setChoice(w.id)}>
                      {w.name}
                      {w.isDefault ? <span className="ml-auto text-xs text-muted-foreground">default</span> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </MenuScrollArea>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button size="sm" variant={compact ? "outline" : "default"} disabled={busy} onClick={() => onStart(chosen.id)}>
          {busy ? <Loader2 className="animate-spin" /> : <Play />}
          {compact ? "Run again" : workflows.length > 1 ? "Start" : `Start ${chosen.name}`}
        </Button>
      </div>
  )
  if (compact) {
    return controls
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-3 text-sm">
      <span className="text-muted-foreground">Not running a workflow.</span>
      {controls}
    </div>
  )
}

/** A round's own figures, in the shape the Spent line takes. */
function roundSpent(round: WorkflowRunPanelRound): WorkflowSpentValue {
  if (round.usage?.state === "shared") {
    return { timeMs: round.timeMs, usage: null, pending: 0, sharedWith: [round.usage.sharedWith ?? "an earlier step"] }
  }
  return { timeMs: round.timeMs, usage: round.usage, pending: round.usage?.state === "pending" ? 1 : 0 }
}

/** Context before → after, with an unknown side as a dash. */
function contextChange(compaction: WorkflowRunPanelCompaction): string {
  const side = (tokens: number | null) => (tokens === null ? "—" : formatCompactNumber(tokens))
  return `${side(compaction.before)} → ${side(compaction.after)}`
}

/**
 * What became of the compaction before a round, and of the round's message after it, in a line.
 * `open`: the round has not ended, so a message not sent can still be sent by restarting the step.
 */
export function compactionText(compaction: WorkflowRunPanelCompaction, open = false): string {
  const unsent = `the round’s message was not sent${open ? "; restart the step to send it" : ""}`
  const after = (sent: string) => (compaction.unsent ? unsent : sent)
  switch (compaction.outcome) {
    case "running":
      return `Compacting the session (${contextChange(compaction)}, over ${formatCompactNumber(compaction.threshold)}); the round’s message waits for it`
    case "compacted":
      return `Session compacted before the round: ${contextChange(compaction)}${compaction.unsent ? `; ${unsent}` : ""}`
    case "not_compacted":
      return `Compaction did not shrink the session (${contextChange(compaction)}); ${after("the message was sent anyway")}`
    case "unknown":
      return `Could not tell whether the session was compacted before the round (${contextChange(compaction)})${compaction.unsent ? `; ${unsent}` : ""}`
    case "failed":
      return `Compaction failed${compaction.error ? `: ${compaction.error}` : ""}; ${after("the message was sent anyway")}`
    case "timed_out":
      return compaction.unsent
        ? `Compaction had not finished when the wait for it gave up (${contextChange(compaction)}); ${unsent}`
        : `Compaction had not finished when the round’s message was sent (${contextChange(compaction)})`
  }
}

/** The compaction before a round: what it did to the session's context. */
function RoundCompaction({ compaction, open }: { compaction: WorkflowRunPanelCompaction; open: boolean }) {
  const trouble =
    compaction.unsent || compaction.outcome === "failed" || compaction.outcome === "not_compacted" || compaction.outcome === "timed_out"
  return (
    <span className={cn("flex min-w-0 basis-full items-center gap-1.5 pl-5", trouble && "text-amber-700 dark:text-amber-300")}>
      {compaction.outcome === "running" ? <Loader2 className="size-3 shrink-0 animate-spin" /> : <Shrink className="size-3 shrink-0" />}
      <span className="min-w-0 [overflow-wrap:anywhere]">{compactionText(compaction, open)}</span>
    </span>
  )
}

/** Who decided what in a round of an approval step, and when. */
function RoundDecisions({ decisions }: { decisions: WorkflowRunPanelDecision[] }) {
  return (
    <ul className="flex min-w-0 basis-full flex-col gap-0.5 pl-5" aria-label="Decisions">
      {decisions.map((decision) => (
        <li key={`${decision.approver.name}-${decision.at}`} className="flex min-w-0 flex-col">
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
            <WorkflowGateIcon gate={decision.verdict === "approve" ? "pass" : "fail"} className="size-3" />
            <span className="text-foreground">{decision.approver.name}</span>
            <span>{decision.verdict === "approve" ? "approved" : "rejected"} by</span>
            <span className="text-foreground">{decision.transition}</span>
            <span>· {formatStamp(decision.at)}</span>
          </span>
          {decision.comment ? <span className="whitespace-pre-wrap pl-4.5 [overflow-wrap:anywhere]">{decision.comment}</span> : null}
        </li>
      ))}
    </ul>
  )
}

/** What the selected step cost; with a gate result, decisions or after a rework, how each round ended and what it did. */
function StepSpent({ step }: { step: WorkflowRunPanelStep }) {
  const rounds = step.rounds ?? []
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {step.spent ? <WorkflowSpent label="Spent" spent={step.spent} /> : null}
      {rounds.length > 1 || rounds.some((round) => round.gate || round.decisions?.length || round.contextTokens != null || round.compaction) ? (
        <ol className="flex min-w-0 flex-col gap-0.5 border-l pl-3" aria-label="Rounds">
          {rounds.map((round) => (
            <li key={round.roundNo} className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              {round.gate ? <WorkflowGateIcon gate={round.gate} className="size-3.5" /> : null}
              <span>Round {round.roundNo}</span>
              {round.transition ? <span className="font-medium text-foreground">{round.transition}</span> : null}
              {round.worker ? <span>· {round.worker.name}</span> : null}
              <WorkflowSpent spent={roundSpent(round)} className="text-xs" />
              {round.usage?.state === "live" ? <span>(so far)</span> : null}
              {round.contextTokens != null ? (
                <span title="The context the round’s session held when the round ended, or now while it is open">
                  · {formatCompactNumber(round.contextTokens)} context
                </span>
              ) : null}
              {round.compaction ? <RoundCompaction compaction={round.compaction} open={round.endedAt === null} /> : null}
              {round.decisions?.length ? <RoundDecisions decisions={round.decisions} /> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

/**
 * The workflow panel on a task's page: the task's run as a row of steps; for
 * the selected step, who works it, how it ended, the actions a person can
 * take, and a row that opens the step's session in the host's chat.
 * With no run, it offers to start one.
 */
export function WorkflowRunPanel<R extends WorkflowRunPanelRun>({
  run,
  history = [],
  spent,
  workflows,
  loading = false,
  openTransitions = [],
  approval,
  busy = null,
  selectedStepId,
  onSelectStep,
  onStart,
  onCancel,
  onRestart,
  onFinish,
  sessionHref,
  onOpenSession,
  renderSummary,
  createWorkflowHref,
  orientation = "auto",
  className,
}: WorkflowRunPanelProps<R>) {
  const rootRef = useRef<HTMLElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [ownSelected, setOwnSelected] = useState<string | null>(null)

  useLayoutEffect(() => {
    const element = rootRef.current
    if (!element || typeof ResizeObserver === "undefined") {
      return
    }
    const measure = () => setNarrow(element.getBoundingClientRect().width < PHONE_WIDTH)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const controlled = selectedStepId !== undefined
  const selected = controlled ? selectedStepId : ownSelected
  const steps = run?.steps ?? []

  // Keep the person's choice while it still exists; otherwise follow the run.
  useEffect(() => {
    if (!controlled && steps.length > 0 && !steps.some((s) => s.stepId === ownSelected)) {
      setOwnSelected(initialStep(steps))
    }
  }, [controlled, steps, ownSelected])

  const select = (id: string) => {
    if (!controlled) {
      setOwnSelected(id)
    }
    onSelectStep?.(id)
  }

  const direction: WorkflowStepperOrientation = orientation === "auto" ? (narrow ? "vertical" : "horizontal") : orientation

  const section = (children: ReactNode) => (
    <section ref={rootRef} data-slot="workflow-run-panel" data-narrow={narrow || undefined} className={cn("flex min-w-0 flex-col gap-3", className)} aria-label="Workflow">
      {children}
    </section>
  )

  if (loading) {
    return section(
      <>
        <PanelHeading />
        <Skeleton className="h-16 w-full" />
      </>,
    )
  }

  if (!run) {
    return section(
      <>
        <PanelHeading />
        <StartWorkflow
          workflows={workflows}
          busy={busy !== null}
          onStart={onStart}
          createWorkflowHref={createWorkflowHref}
        />
      </>,
    )
  }

  // An ended run is shown to be read and run again, not steered.
  const live = run.state === "active"
  const step = steps.find((s) => s.stepId === selected) ?? null
  const isOpen = live && step !== null && isOpenStep(step)
  const approvalOpen = live && approval != null && steps.some(isOpenStep)
  // A step its approvers decided had no session to open, and its rounds say who decided.
  const decided = step?.rounds?.some((round) => round.decisions?.length) ?? false
  const href = step && sessionHref ? sessionHref(step) : null
  // How the selected step ended: its gate result and the transition its last round took.
  const gate = step ? workflowStepGate(step) : null
  const tookTransition = step?.state === "done" ? (step.rounds?.at(-1)?.transition ?? null) : null

  // One list for a step's context menu and the selected step's … button.
  const stepMenu = (item: R["steps"][number]): ItemMenuEntries => {
    const itemHref = sessionHref ? sessionHref(item) : null
    const itemOpen = item.state === "active" || item.state === "waiting"
    return [
      onOpenSession && item.threadId && { id: "session", label: "Open the session", icon: MessagesSquare, group: "open", onSelect: () => onOpenSession(item) },
      itemHref && { id: "thread", label: "Open the thread", icon: ExternalLink, group: "open", onSelect: () => window.open(itemHref, "_blank") },
      live && {
        id: "restart",
        label: itemOpen ? "Restart this step" : "Go back to this step",
        icon: RotateCcw,
        disabled: busy !== null,
        onSelect: () => onRestart(item),
      },
      live && { id: "cancel", label: "Cancel the run…", icon: Square, destructive: true, disabled: busy !== null, onSelect: onCancel },
    ]
  }

  return section(
    <>
      <PanelHeading>
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {run.workflowName} · {live ? `started ${formatStamp(run.startedAt)} by ${run.startedBy.name}` : `${run.state} ${formatStamp(run.endedAt)}`}
        </span>
        {live ? (
          <Button variant="ghost" size="sm" className="ml-auto shrink-0" disabled={busy !== null} onClick={onCancel}>
            {busy === "cancel" ? <Loader2 className="animate-spin" /> : <Square />}
            Cancel run
          </Button>
        ) : (
          <StartWorkflow workflows={workflows} busy={busy !== null} compact onStart={onStart} />
        )}
      </PanelHeading>

      <WorkflowStepper
        steps={stepperItems(steps, approvalOpen)}
        selectedId={selected}
        onSelect={select}
        orientation={direction}
        renderStep={(item, button) => {
          const runStep = steps.find((s) => s.stepId === item.id)
          return (
            <ItemContextMenu entries={runStep ? stepMenu(runStep) : []} render={<div />} className="min-w-0">
              {button}
            </ItemContextMenu>
          )
        }}
      />

      {step ? (
        <div className="flex min-w-0 flex-col gap-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span className="font-medium">{step.name}</span>
            <span className="text-muted-foreground">
              {isOpen && approvalOpen ? AWAITING_APPROVAL : workflowStepStateLabel(step.state, gate)}
            </span>
            {step.agentName ? <span className="text-muted-foreground">Agent: {step.agentName}</span> : null}
            {step.attempts > 1 ? <span className="text-muted-foreground">Round {step.attempts}</span> : null}
            {step.startedAt ? (
              <span className="text-muted-foreground">
                {formatStamp(step.startedAt)}
                {step.endedAt ? ` → ${formatStamp(step.endedAt)}` : ""}
              </span>
            ) : null}
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <ItemActionsMenu entries={stepMenu(step)} label={`${step.name} step actions`} />
              {href && !onOpenSession ? (
                <Button variant="ghost" size="sm" render={<a href={href} target="_blank" rel="noreferrer" />}>
                  <ExternalLink />
                  Open the thread
                </Button>
              ) : null}
              {live ? (
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => onRestart(step)}>
                  {busy === "restart" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                  {isOpen ? "Restart step" : "Go back here"}
                </Button>
              ) : null}
              {isOpen && openTransitions.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button size="sm" disabled={busy !== null} />}>
                    {busy === "finish" ? <Loader2 className="animate-spin" /> : null}
                    Advance
                    <ChevronDown />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className={MENU_SCROLL_POPUP}>
                    <MenuScrollArea>
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Finish {step.name} by</DropdownMenuLabel>
                        {openTransitions.map((to) => (
                          <DropdownMenuItem key={to} onClick={() => onFinish(to)}>
                            {to}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </MenuScrollArea>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>

          {step.error ? (
            <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">{step.error}</p>
          ) : null}

          {step.outcome || step.summary ? (
            <div className="flex min-w-0 flex-col gap-1 text-sm">
              {step.outcome ? (
                <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground">
                  {gate ? <WorkflowGateIcon gate={gate} /> : null}
                  {tookTransition ? <span className="font-medium text-foreground">{tookTransition}</span> : null}
                  <span>
                    {tookTransition ? "· moved to " : "Ended in "}
                    <span className="font-medium text-foreground">{step.outcome}</span>
                    {step.finishedBy ? ` by ${step.finishedBy}` : ""}
                  </span>
                </span>
              ) : null}
              {step.summary ? (
                renderSummary ? (
                  <div className="min-w-0 [overflow-wrap:anywhere]">{renderSummary(step.summary, step)}</div>
                ) : (
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{step.summary}</p>
                )
              ) : null}
            </div>
          ) : null}

          {step.state !== "pending" && step.spent ? <StepSpent step={step} /> : null}

          {isOpen && approvalOpen ? (
            approval
          ) : step.threadId && step.chatSlug ? (
            onOpenSession ? (
              <Button variant="outline" className="h-auto w-full justify-start py-2 text-left" onClick={() => onOpenSession(step)}>
                <MessagesSquare />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">Open the session</span>
                  <span className="truncate text-xs font-normal text-muted-foreground">in {step.chatSlug}</span>
                </span>
                <ChevronRight className="text-muted-foreground" />
              </Button>
            ) : null
          ) : decided ? null : (
            <p className="text-sm text-muted-foreground">
              {step.state === "pending" ? "This step has not been reached yet." : "No session was opened for this step."}
            </p>
          )}
        </div>
      ) : null}

      {spent && (spent.timeMs > 0 || spent.usage) ? <WorkflowSpent label="Spent on this task" spent={spent} className="text-xs" /> : null}

      {history.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {history.length} earlier run{history.length === 1 ? "" : "s"} on this task: {history.map((r) => `${r.workflowName} (${r.state}, ${formatStamp(r.startedAt)})`).join(", ")}
        </p>
      ) : null}
    </>,
  )
}
