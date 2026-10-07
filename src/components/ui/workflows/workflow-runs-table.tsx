import { ExternalLink, MoreHorizontal, Square, SquareArrowOutUpRight, X } from "lucide-react"

import { Button } from "../button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../context-menu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../dropdown-menu"
import { ScrollArea } from "@/components/ui/layout/scroll-area"
import { Popover, PopoverContent, PopoverTrigger } from "../popover"
import { Skeleton } from "../skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../table"
import { MENU_SCROLL_POPUP, MenuScrollArea } from "@/components/ui/tasks/item-menu"
import { cn } from "cn"

import { type WorkflowGate, type WorkflowStepState, WorkflowStepStateIcon, workflowStepGate, workflowStepStateLabel } from "./workflow-stepper"

export type WorkflowRunState = "active" | "finished" | "cancelled"
export type WorkflowRunsFilter = WorkflowRunState | "all"

/** The step fields the table reads, named as a run step carries them. */
export interface WorkflowRunsTableStep {
  stepId: string
  name: string
  state: WorkflowStepState
  agentName: string | null
  chatRef: string | null
  threadId: string | null
  attempts: number
  error: string | null
  /** Its rounds, oldest first: a done step's chip shows its last round's gate result. */
  rounds?: ReadonlyArray<{ gate?: WorkflowGate | null }>
}

/** The run fields the table reads, named as a workflow run carries them, so a run passes in as it is. */
export interface WorkflowRunsTableRun<S extends WorkflowRunsTableStep = WorkflowRunsTableStep> {
  id: string
  taskKey: string
  state: WorkflowRunState
  startedBy: { name: string }
  startedAt: string
  steps: S[]
}

export interface WorkflowRunsTableProps<R extends WorkflowRunsTableRun> {
  /** null while loading. */
  runs: R[] | null
  filter: WorkflowRunsFilter
  onFilterChange: (filter: WorkflowRunsFilter) => void
  onOpenTask: (run: R) => void
  /** Opens the session of the run's open step; offered only when that step has a thread. */
  onOpenSession: (run: R, step: R["steps"][number]) => void
  /** Cancels an active run. The host confirms first. */
  onCancel: (run: R) => void
  /**
   * The runs shown are the ones some figure counted, e.g. "Sent back from
   * Review · last 30 days". A bar names them with a button to clear it, and
   * the state filter is hidden, since the scope already selects the runs.
   */
  scope?: { label: string; onClear: () => void }
  /** What an empty table says. Defaults per filter, or per scope. */
  emptyText?: string
  className?: string
}

const FILTERS: Array<{ id: WorkflowRunsFilter; label: string }> = [
  { id: "active", label: "Active" },
  { id: "finished", label: "Finished" },
  { id: "cancelled", label: "Cancelled" },
  { id: "all", label: "All" },
]

const STATE_TONE: Record<WorkflowRunState, string> = {
  active: "bg-blue-500/12 text-blue-700 dark:text-blue-300",
  finished: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  cancelled: "bg-muted text-muted-foreground",
}

// The chips sit in a row that opens its task; their clicks and keys stay with the chip and its popover.
const keepInChip = (event: { stopPropagation: () => void }) => event.stopPropagation()

/** A run's step: its state icon and name; a click or a tap opens its state, worker, rounds and error in a popover. */
function RunStepChip({ step }: { step: WorkflowRunsTableStep }) {
  const gate = workflowStepGate(step)
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            onClick={keepInChip}
            onKeyDown={keepInChip}
            className="flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-muted"
          />
        }
      >
        <WorkflowStepStateIcon state={step.state} gate={gate} className="size-3.5" />
        <span className="truncate">{step.name}</span>
        {step.attempts > 1 ? <span className="shrink-0 text-muted-foreground">×{step.attempts}</span> : null}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-max max-w-72 gap-0.5 p-2.5 text-xs" onClick={keepInChip} onKeyDown={keepInChip}>
        <span className="font-medium break-words">{step.name}</span>
        <span>{workflowStepStateLabel(step.state, gate)}</span>
        {step.agentName ? <span className="text-muted-foreground break-words">{step.agentName}</span> : null}
        {step.attempts > 1 ? <span className="text-muted-foreground">{step.attempts} rounds</span> : null}
        {step.error ? <span className="whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]">{step.error}</span> : null}
      </PopoverContent>
    </Popover>
  )
}

function formatStamp(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"
}

/**
 * One workflow's runs: which tasks are running it or ran it, where each run
 * is, and who worked each step. A row opens its task; its menu (the "…"
 * button, or a right-click / long press on the row) also opens the open
 * step's session or cancels the run.
 */
export function WorkflowRunsTable<R extends WorkflowRunsTableRun>({
  runs,
  filter,
  onFilterChange,
  onOpenTask,
  onOpenSession,
  onCancel,
  scope,
  emptyText,
  className,
}: WorkflowRunsTableProps<R>) {
  const menu = (
    run: R,
    Item: typeof ContextMenuItem | typeof DropdownMenuItem,
    Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator,
  ) => {
    const open = run.steps.find((s) => s.state === "active" || s.state === "waiting")
    return (
      <>
        <Item onClick={() => onOpenTask(run)}>
          <SquareArrowOutUpRight />
          Open {run.taskKey}
        </Item>
        {open?.threadId && open.chatRef ? (
          <Item onClick={() => onOpenSession(run, open)}>
            <ExternalLink />
            Open {open.name} session
          </Item>
        ) : null}
        {run.state === "active" ? (
          <>
            <Separator />
            <Item variant="destructive" onClick={() => onCancel(run)}>
              <Square />
              Cancel run
            </Item>
          </>
        ) : null}
      </>
    )
  }

  return (
    <div data-slot="workflow-runs-table" className={cn("flex min-w-0 flex-col gap-3", className)}>
      {scope ? (
        <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-3 text-sm">
          <span className="min-w-0 flex-1 break-words">{scope.label}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Show all runs" onClick={scope.onClear}>
            <X />
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Show runs">
          {FILTERS.map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant={filter === option.id ? "secondary" : "ghost"}
              aria-pressed={filter === option.id}
              onClick={() => onFilterChange(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}

      {!runs ? (
        <Skeleton className="h-32 w-full" />
      ) : runs.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {emptyText ?? (scope ? "No runs match." : filter === "active" ? "No task is running this workflow now. Start it from a task’s page." : "No runs here.")}
        </p>
      ) : (
        <ScrollArea scrollbars="horizontal">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Task</TableHead>
                <TableHead>Steps</TableHead>
                <TableHead className="w-28">State</TableHead>
                <TableHead className="hidden w-40 md:table-cell">Started</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <ContextMenu key={run.id}>
                  <ContextMenuTrigger
                    render={
                      <TableRow
                        className="cursor-pointer outline-none focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
                        tabIndex={0}
                        onClick={() => onOpenTask(run)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            onOpenTask(run)
                          }
                        }}
                      />
                    }
                  >
                    <TableCell className="font-mono text-xs">{run.taskKey}</TableCell>
                    <TableCell className="whitespace-normal">
                      <ol className="flex flex-wrap items-center gap-1.5">
                        {run.steps.map((step) => (
                          <li key={step.stepId} className="flex max-w-full min-w-0">
                            <RunStepChip step={step} />
                          </li>
                        ))}
                      </ol>
                    </TableCell>
                    <TableCell>
                      <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium capitalize", STATE_TONE[run.state])}>{run.state}</span>
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                      {formatStamp(run.startedAt)} · {run.startedBy.name}
                    </TableCell>
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${run.taskKey} run actions`} />}>
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className={MENU_SCROLL_POPUP}>
                          <MenuScrollArea>{menu(run, DropdownMenuItem, DropdownMenuSeparator)}</MenuScrollArea>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </ContextMenuTrigger>
                  <ContextMenuContent className={MENU_SCROLL_POPUP}>
                    <MenuScrollArea>{menu(run, ContextMenuItem, ContextMenuSeparator)}</MenuScrollArea>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      )}
    </div>
  )
}
