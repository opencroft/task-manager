import { Check, ChevronDown, CircleCheck, CircleX, Hourglass, Loader2, ShieldCheck, X } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "../button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../dropdown-menu"
import { MENU_SCROLL_POPUP, MenuScrollArea } from "../tasks/item-menu"
import { TaskAssignee } from "../tasks/task-assignee"
import { Textarea } from "../textarea"
import { cn } from "cn"

export type WorkflowApprovalVerdict = "approve" | "reject"

/** One approver's decision in the step's open round. */
export interface WorkflowApprovalDecision {
  verdict: WorkflowApprovalVerdict
  /** The label of the transition they chose. */
  transition: string
  comment: string | null
  /** ISO 8601. */
  at: string
}

export interface WorkflowApprovalBarApprover {
  personId: string
  name: string
  required: boolean
  /** Null while they have not decided. */
  decision: WorkflowApprovalDecision | null
}

export interface WorkflowApprovalBarProps {
  stepName: string
  /** Approvals that pass the step, required ones included. */
  needed: number
  approvers: WorkflowApprovalBarApprover[]
  /** Labels of the transitions each verdict may take, in the step's order. */
  transitions: Record<WorkflowApprovalVerdict, string[]>
  /** Whether the viewer is an approver: only then are the comment and the buttons shown. */
  canDecide: boolean
  /** The viewer's person id, to show their own decision. */
  viewerId?: string | null
  /** The verdict being sent, so its button spins and the other waits. */
  busy?: WorkflowApprovalVerdict | null
  /** The viewer decides by one of the verdict's transitions, with what they wrote (may be empty). */
  onDecide: (verdict: WorkflowApprovalVerdict, transition: string, comment: string) => void
  className?: string
}

const VERDICT = {
  approve: { label: "Approve", done: "Approved", icon: CircleCheck, tone: "text-emerald-600 dark:text-emerald-400" },
  reject: { label: "Reject", done: "Rejected", icon: CircleX, tone: "text-red-600 dark:text-red-400" },
} as const

function formatStamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function ApproverRow({ approver }: { approver: WorkflowApprovalBarApprover }) {
  const decision = approver.decision
  const verdict = decision ? VERDICT[decision.verdict] : null
  const Icon = verdict?.icon ?? Hourglass
  return (
    <li className="flex min-w-0 flex-col gap-0.5 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <TaskAssignee assignee={{ kind: "person", id: approver.personId, name: approver.name }} withName size="sm" className="min-w-0" />
        {approver.required ? <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">Required</span> : null}
        <span className={cn("ml-auto flex min-w-0 items-center gap-1.5", verdict ? verdict.tone : "text-muted-foreground")}>
          <Icon className="size-4 shrink-0" />
          {decision && verdict ? (
            <span className="min-w-0 truncate">
              {verdict.done} · <span className="text-foreground">{decision.transition}</span>
              <span className="text-muted-foreground"> · {formatStamp(decision.at)}</span>
            </span>
          ) : (
            <span>Not decided</span>
          )}
        </span>
      </div>
      {decision?.comment ? <p className="whitespace-pre-wrap pl-8 text-sm text-muted-foreground [overflow-wrap:anywhere]">{decision.comment}</p> : null}
    </li>
  )
}

/** One verdict's button: it takes the verdict's only transition, or opens a choice of several. */
function VerdictButton({
  verdict,
  transitions,
  busy,
  onPick,
}: {
  verdict: WorkflowApprovalVerdict
  transitions: string[]
  busy: WorkflowApprovalVerdict | null
  onPick: (transition: string) => void
}) {
  const { label } = VERDICT[verdict]
  const variant = verdict === "approve" ? "default" : "outline"
  const tone = verdict === "reject" ? "text-destructive" : undefined
  const glyph = busy === verdict ? <Loader2 className="animate-spin" /> : verdict === "approve" ? <Check /> : <X />
  if (transitions.length === 0) {
    return null
  }
  if (transitions.length === 1) {
    return (
      <Button size="sm" variant={variant} className={tone} disabled={busy !== null} onClick={() => onPick(transitions[0])}>
        {glyph}
        {label}
      </Button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" variant={variant} className={tone} disabled={busy !== null} />}>
        {glyph}
        {label}
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={MENU_SCROLL_POPUP}>
        <MenuScrollArea>
          <DropdownMenuGroup>
            <DropdownMenuLabel>{label} by</DropdownMenuLabel>
            {transitions.map((transition) => (
              <DropdownMenuItem key={transition} onClick={() => onPick(transition)}>
                {transition}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </MenuScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A task's open approval step: where the approval stands and, for an
 * approver, the controls to decide it. The step passes once every required
 * approver approved and the approvals reach the number needed; one Reject
 * sends the task back.
 */
export function WorkflowApprovalBar({
  stepName,
  needed,
  approvers,
  transitions,
  canDecide,
  viewerId = null,
  busy = null,
  onDecide,
  className,
}: WorkflowApprovalBarProps) {
  const [comment, setComment] = useState("")
  const approved = approvers.filter((a) => a.decision?.verdict === "approve").length
  const mine = viewerId ? approvers.find((a) => a.personId === viewerId)?.decision : null
  // A decision that went through takes its comment with it; a refused one leaves the comment to retry.
  useEffect(() => setComment(""), [mine?.at])
  const decide = (verdict: WorkflowApprovalVerdict) => (transition: string) => onDecide(verdict, transition, comment.trim())

  return (
    <section
      data-slot="workflow-approval-bar"
      aria-label={`${stepName}: approval`}
      className={cn("flex min-w-0 flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3", className)}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <ShieldCheck className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <h3 className="min-w-0 truncate text-sm font-semibold">{stepName} needs approval</h3>
        <span className="ml-auto text-sm text-muted-foreground tabular-nums">
          {approved} of {needed} approval{needed === 1 ? "" : "s"}
        </span>
      </header>

      <ul className="flex min-w-0 flex-col divide-y" aria-label="Approvers">
        {approvers.map((approver) => (
          <ApproverRow key={approver.personId} approver={approver} />
        ))}
      </ul>

      {canDecide ? (
        <div className="flex min-w-0 flex-col gap-2">
          {mine ? (
            <p className="text-xs text-muted-foreground">
              You {VERDICT[mine.verdict].done.toLowerCase()} by {mine.transition}. You can change your decision until the step is decided.
            </p>
          ) : null}
          <Textarea
            value={comment}
            rows={2}
            placeholder="Comment (optional): the reason goes to whoever gets the task next"
            aria-label="Comment"
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <VerdictButton verdict="reject" transitions={transitions.reject} busy={busy} onPick={decide("reject")} />
            <VerdictButton verdict="approve" transitions={transitions.approve} busy={busy} onPick={decide("approve")} />
          </div>
        </div>
      ) : null}
    </section>
  )
}
