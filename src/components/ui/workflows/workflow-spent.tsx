import type { ReactNode } from "react"

import { Popover, PopoverContent, PopoverTrigger } from "../popover"
import { cn } from "@/lib/utils"
import { formatCompactNumber } from "../utils/compact-number"

/** Tokens and cost an agent session spent, summed from the chat's own turn records. */
export interface WorkflowSpentUsage {
  turns: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  /** One entry per currency the turns were priced in; empty when none was priced. */
  cost: Array<{ amount: number; currency: string }>
}

/** Wall time and usage over some rounds. `pending`: rounds whose finishing turn is not counted yet. */
export interface WorkflowSpentValue {
  timeMs: number
  /** Null when no round had an agent session: a person's time has no tokens. */
  usage: WorkflowSpentUsage | null
  pending: number
  /**
   * Steps whose round counted the one turn some of these rounds happened
   * inside: an agent that takes the next step's message mid-turn works both
   * in one turn. Those rounds have no figures of their own.
   */
  sharedWith?: string[]
}

/** A wall time as it reads in a line: 45s, 12m, 3h 20m, 2d 4h. */
export function formatSpentTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) {
    return `${s}s`
  }
  const m = Math.round(s / 60)
  if (m < 60) {
    return `${m}m`
  }
  const h = Math.floor(m / 60)
  if (h < 24) {
    const rest = m % 60
    return rest ? `${h}h ${rest}m` : `${h}h`
  }
  const d = Math.floor(h / 24)
  const rest = h % 24
  return rest ? `${d}d ${rest}h` : `${d}d`
}

/** One amount in its currency: $0.42, $12.30, and below a cent $0.0042. */
export function formatMoney(amount: number, currency: string): string {
  const digits = amount !== 0 && Math.abs(amount) < 0.01 ? 4 : 2
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount)
  } catch {
    return `${amount.toFixed(digits)} ${currency}`
  }
}

/** Cost per currency, joined: "$1.20", or "$1.20 + €0.40" for a mix; "" when nothing was priced. */
export function formatCost(cost: WorkflowSpentUsage["cost"]): string {
  return cost.map((c) => formatMoney(c.amount, c.currency)).join(" + ")
}

/** The tokens figure; a click or a tap opens its kinds (input, output, cache) in a popover. */
function SpentTokens({ tokens }: { tokens: WorkflowSpentUsage["tokens"] }) {
  const kinds: Array<[string, number]> = [
    ["input", tokens.input],
    ["output", tokens.output],
    ["cache read", tokens.cacheRead],
    ["cache write", tokens.cacheWrite],
  ]
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="cursor-pointer rounded-sm tabular-nums underline decoration-muted-foreground/50 decoration-dotted underline-offset-4 outline-none data-[popup-open]:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        }
      >
        {formatCompactNumber(tokens.total)} tokens
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-max max-w-64 gap-1 p-2.5 text-xs tabular-nums">
        <span className="font-medium">{tokens.total.toLocaleString()} tokens</span>
        {kinds.map(([kind, count]) => (
          <span key={kind} className="flex items-baseline justify-between gap-4">
            <span className="text-muted-foreground">{kind}</span>
            <span>{count.toLocaleString()}</span>
          </span>
        ))}
      </PopoverContent>
    </Popover>
  )
}

export interface WorkflowSpentProps {
  spent: WorkflowSpentValue
  /** A lead-in, e.g. "Spent" or "Spent on this task". */
  label?: ReactNode
  className?: string
}

/**
 * Time, tokens and cost in one line. Tokens and cost come from the step
 * session's chat, never from the agent. A click or a tap on the tokens opens
 * their kinds in a popover.
 * A figure still missing the turn that finished its step says so rather than
 * passing for final, and rounds that shared a turn with an earlier step say
 * so rather than showing zero.
 */
export function WorkflowSpent({ spent, label, className }: WorkflowSpentProps) {
  const { usage } = spent
  const cost = usage ? formatCost(usage.cost) : ""
  return (
    <span data-slot="workflow-spent" className={cn("inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm text-muted-foreground tabular-nums", className)}>
      {label ? <span className="font-medium text-foreground">{label}</span> : null}
      <span>
        <span className="sr-only">Wall time </span>
        {formatSpentTime(spent.timeMs)}
      </span>
      {usage ? (
        <>
          <span aria-hidden="true">·</span>
          <SpentTokens tokens={usage.tokens} />
          <span aria-hidden="true">·</span>
          <span>
            {usage.turns} {usage.turns === 1 ? "turn" : "turns"}
          </span>
          {cost ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-foreground">{cost}</span>
            </>
          ) : null}
        </>
      ) : null}
      {spent.pending > 0 ? (
        <span className="text-xs">
          (so far: {spent.pending === 1 ? "a round's" : `${spent.pending} rounds'`} last turn still running)
        </span>
      ) : null}
      {spent.sharedWith?.length ? <span className="text-xs">(shared a turn with {spent.sharedWith.join(", ")})</span> : null}
    </span>
  )
}
