import { ArrowRight, Check, ChevronDown, Flag, Plus, Trash2 } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "../button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu"
import { Input } from "../input"
import { MENU_SCROLL_POPUP, MenuScrollArea } from "../tasks/item-menu"
import { cn } from "cn"

import { type WorkflowGate, WorkflowGateIcon } from "./workflow-stepper"

/** One way out of a step, as it is edited. */
export interface WorkflowTransitionValue {
  /** Identifies the row while it is edited. */
  key: string
  /** The stored transition's id; absent for a new one. */
  id?: string
  /** What the step's agent picks it by and the run shows. Empty: the server makes one from where it leads. */
  label: string
  /** The id of the step that opens next; null ends the run. */
  toStep: string | null
  /** The status the task moves to; null until one is chosen. */
  status: number | null
  /** A gate result set by hand; null takes the one `derivedGate` gives. */
  gate: WorkflowGate | null
}

export interface WorkflowTransitionListProps {
  value: WorkflowTransitionValue[]
  onChange: (value: WorkflowTransitionValue[]) => void
  /** The steps a transition can lead to, in the workflow's order: every step but the one being edited. */
  steps: Array<{ id: string; name: string }>
  statuses: Array<{ id: number; name: string; display: ReactNode }>
  /** The gate result a transition into `toStep` has when none is set by hand. */
  derivedGate: (toStep: string | null) => WorkflowGate
  /** Messages for a row, keyed `<index>` for the row as a whole or `<index>.<field>` (`label`, `toStep`, `status`, `gate`). */
  issues?: Partial<Record<string, string[]>>
  /** A key for a row that Add creates. */
  newKey?: () => string
}

const GATE_TEXT: Record<WorkflowGate, string> = { pass: "Passes", fail: "Sends back" }

function Picker({ label, invalid, children, menu }: { label: string; invalid?: boolean; children: ReactNode; menu: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" aria-label={label} aria-invalid={invalid || undefined} className="w-full min-w-0 justify-between font-normal" />}
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">{children}</span>
        <ChevronDown className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className={cn("min-w-52", MENU_SCROLL_POPUP)}>
        <MenuScrollArea>{menu}</MenuScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Checked({ on }: { on: boolean }) {
  return <Check className={cn("size-4", on ? "opacity-100" : "opacity-0")} />
}

/**
 * The ways a step can be finished. Each row is a transition: its label, the
 * step that opens next (or the end of the run), the status the task moves to,
 * and its gate result. The gate shows what where it leads gives (a later step
 * or the end passes, the same or an earlier step sends back) until it is set
 * by hand, and can be put back to automatic.
 */
export function WorkflowTransitionList({
  value,
  onChange,
  steps,
  statuses,
  derivedGate,
  issues = {},
  newKey = () => crypto.randomUUID(),
}: WorkflowTransitionListProps) {
  const update = (index: number, patch: Partial<WorkflowTransitionValue>) =>
    onChange(value.map((t, i) => (i === index ? { ...t, ...patch } : t)))
  const add = () => onChange([...value, { key: newKey(), label: "", toStep: steps[0]?.id ?? null, status: null, gate: null }])

  return (
    <div data-slot="workflow-transition-list" className="flex min-w-0 flex-col gap-2">
      {value.length > 0 ? (
        <ol className="flex min-w-0 flex-col gap-2" aria-label="Transitions">
          {value.map((t, index) => {
            const target = steps.find((s) => s.id === t.toStep)
            const status = statuses.find((s) => s.id === t.status)
            const automatic = derivedGate(t.toStep)
            const gate = t.gate ?? automatic
            const rowIssues = Object.entries(issues)
              .filter(([key]) => key === String(index) || key.startsWith(`${index}.`))
              .flatMap(([, messages]) => messages ?? [])
            const invalid = (field: string) => Boolean(issues[`${index}.${field}`]?.length)
            return (
              <li key={t.key} className="flex min-w-0 flex-col gap-1">
                <div className="grid min-w-0 gap-1.5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto] sm:items-center">
                  <Input
                    value={t.label}
                    placeholder={gate === "pass" ? "Label, e.g. Approved" : "Label, e.g. Changes requested"}
                    aria-label="Transition label"
                    aria-invalid={invalid("label") || undefined}
                    onChange={(event) => update(index, { label: event.target.value })}
                    className="h-8"
                  />
                  <Picker
                    label="Step that opens next"
                    invalid={invalid("toStep")}
                    menu={
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Opens next</DropdownMenuLabel>
                        {steps.map((s) => (
                          <DropdownMenuItem key={s.id} onClick={() => update(index, { toStep: s.id })}>
                            <ArrowRight />
                            <span className="flex-1">{s.name || "Untitled step"}</span>
                            <Checked on={s.id === t.toStep} />
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => update(index, { toStep: null })}>
                          <Flag />
                          <span className="flex-1">End the run</span>
                          <Checked on={t.toStep === null} />
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    }
                  >
                    {t.toStep === null ? (
                      <>
                        <Flag className="size-3.5 text-muted-foreground" />
                        End the run
                      </>
                    ) : (
                      <>
                        <ArrowRight className="size-3.5 text-muted-foreground" />
                        {target ? target.name || "Untitled step" : <span className="text-muted-foreground">A removed step</span>}
                      </>
                    )}
                  </Picker>
                  <Picker
                    label="Status the task moves to"
                    invalid={invalid("status")}
                    menu={
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Moves the task to</DropdownMenuLabel>
                        {statuses.map((s) => (
                          <DropdownMenuItem key={s.id} onClick={() => update(index, { status: s.id })}>
                            <span className="flex-1">{s.display}</span>
                            <Checked on={s.id === t.status} />
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    }
                  >
                    {status ? status.display : <span className="text-muted-foreground">Choose a status</span>}
                  </Picker>
                  <Picker
                    label="Gate result"
                    invalid={invalid("gate")}
                    menu={
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Gate result</DropdownMenuLabel>
                        <DropdownMenuItem onClick={() => update(index, { gate: null })}>
                          <WorkflowGateIcon gate={automatic} />
                          <span className="flex-1">Automatic: {GATE_TEXT[automatic].toLowerCase()}</span>
                          <Checked on={t.gate === null} />
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {(["pass", "fail"] as const).map((g) => (
                          <DropdownMenuItem key={g} onClick={() => update(index, { gate: g })}>
                            <WorkflowGateIcon gate={g} />
                            <span className="flex-1">{GATE_TEXT[g]}</span>
                            <Checked on={t.gate === g} />
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    }
                  >
                    <WorkflowGateIcon gate={gate} className="size-3.5" />
                    {GATE_TEXT[gate]}
                    {t.gate === null ? <span className="text-xs text-muted-foreground">auto</span> : null}
                  </Picker>
                  <Button variant="ghost" size="icon-sm" aria-label="Remove transition" onClick={() => onChange(value.filter((_, i) => i !== index))}>
                    <Trash2 />
                  </Button>
                </div>
                {rowIssues.length > 0 ? (
                  <ul className="flex flex-col gap-0.5 text-xs text-destructive">
                    {rowIssues.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : null}
      <Button variant="ghost" size="xs" className="self-start text-muted-foreground" onClick={add}>
        <Plus />
        Add a transition
      </Button>
    </div>
  )
}
