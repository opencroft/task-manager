import { ArrowDown, ArrowUp, Bot, Check, ChevronDown, Copy, MessagesSquare, MoreHorizontal, ShieldCheck, Trash2, UserRound } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "../button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu"
import { EffortSelector } from "@/components/effort-selector"
import { Input } from "../input"
import { ModeSelector } from "@/components/mode-selector"
import { type PresenceValue, PresenceSelector } from "@/components/presence-selector"
import { Textarea } from "../textarea"
import { MENU_SCROLL_POPUP, MenuScrollArea } from "../tasks/item-menu"
import { TaskAvatarPicture } from "../tasks/task-assignee"
import { cn } from "cn"

import { type WorkflowApprovalValue, type WorkflowApproverPerson, WorkflowApproversEditor } from "./workflow-approvers-editor"
import type { WorkflowGate } from "./workflow-stepper"
import { WorkflowTransitionList, type WorkflowTransitionValue } from "./workflow-transition-list"

export interface WorkflowStepCardStatus {
  id: number
  name: string
  /** How the status is drawn in lists: usually a status badge. */
  display: ReactNode
}

/** An agent that can work a step: a member of the chat the step's session opens in. */
export interface WorkflowStepCardAgent {
  nodeId: string
  name: string
}

export type WorkflowStepKind = "agent" | "approval"

/** A thread of the step's agent in the chat, which the step can be worked in. */
export interface WorkflowStepCardThread {
  /** What `worker.thread` holds. */
  ref: string
  /** Its title in the chat's thread list; null shows the ref. */
  title: string | null
  /** The folder it is filed in, by name; null or absent at the top level. */
  folder?: string | null
}

export interface WorkflowStepCardValue {
  name: string
  /** `agent`: an agent's session works the step. `approval`: its approvers decide it, and worker, folder, session settings and instructions do not apply. */
  kind: WorkflowStepKind
  /** Who decides an approval step; kept while the step is an agent step, so switching back and forth loses nothing. */
  approval: WorkflowApprovalValue
  triggerStatus: number | null
  /** A fixed agent's step may name `thread`, an existing thread of that agent's in the chat, to be worked in instead of the agent's own thread on each task. */
  worker: { kind: "assignee" } | { kind: "agent"; agentNodeId: string; thread?: string }
  instructions: string
  /** The ways the step's agent may finish it, in the order offered. */
  transitions: WorkflowTransitionValue[]
  /** The folder of the chat's thread list the step's thread is filed in, by name; empty for the top level. */
  folder: string
  /**
   * Session settings applied each time the step starts; a key that is absent is left as the session has it.
   * `compactAbove` is the step's own: the context, in tokens, above which a session the step comes back to
   * is compacted before its message. Absent takes the host's default; 0 never compacts.
   */
  sessionOptions: { effort?: string; presence?: PresenceValue; permissionMode?: string; compactAbove?: number }
}

/** What an editor of the host's own is given when it stands in for the instructions' text field. */
export interface WorkflowStepInstructionsField {
  /** The instructions as stored, placeholders as written. */
  value: string
  onChange: (instructions: string) => void
  placeholder: string
  /** The field has validation messages, which its frame shows. */
  invalid: boolean
}

/** What the session settings offer: every level the workflow definition accepts, not what one agent happens to list. */
const SESSION_EFFORTS = ["max", "extra", "high", "medium", "low", "default", "off"]
const SESSION_MODES = ["auto", "plan", "manual-edits", "accept-edits", "reject-edits", "bypass"]

const INSTRUCTIONS_PLACEHOLDER = "What should the agent do in this step?"

/** The box around a host editor: a document editor's plain border and the invalid state. Its toolbar and text inset are the editor's own. */
const INSTRUCTIONS_FRAME =
  "flex min-w-0 flex-col rounded-md border data-invalid:border-destructive data-invalid:ring-3 data-invalid:ring-destructive/20 dark:data-invalid:border-destructive/50 dark:data-invalid:ring-destructive/40"

export interface WorkflowStepCardProps {
  index: number
  count: number
  value: WorkflowStepCardValue
  onChange: (value: WorkflowStepCardValue) => void
  statuses: WorkflowStepCardStatus[]
  /** The agents a step can be given to: the members of the chat every step's session opens in. */
  agents: WorkflowStepCardAgent[]
  /** That chat's name, for the agent picker's heading. */
  chatName?: string
  /**
   * The live threads of the step's fixed agent in that chat, which the Thread picker offers; `undefined` while they load.
   * Not used for a step worked by the task's assignee.
   */
  threads?: WorkflowStepCardThread[]
  /** The people who can approve an approval step: the host's directory. */
  people?: WorkflowApproverPerson[]
  /** The workflow's other steps, in order: where a transition can lead. */
  steps: Array<{ id: string; name: string }>
  /** The gate result a transition into `toStep` has when none is set by hand. */
  derivedGate: (toStep: string | null) => WorkflowGate
  /**
   * Validation messages by field: `name`, `kind`, `triggerStatus`, `worker`, `worker.thread`, `folder`, `instructions`, `transitions`,
   * and an approval step's `approval.approvers`, `approval.approvers.<index>`, `approval.needed` and
   * `approval.rejectingAgents.<index>`.
   * The session settings share one field: `sessionOptions.effort`, `sessionOptions.presence` and
   * `sessionOptions.permissionMode` are shown together under it; `sessionOptions.compactAbove` has its own.
   * A transition's are keyed `transitions.<index>.<field>`, or `transitions.<index>` for the transition as a whole.
   */
  issues?: Partial<Record<string, string[]>>
  /** Placeholders the instructions can use, offered in the Insert menu. */
  placeholders: Array<{ token: string; label: string }>
  /**
   * The instructions' editor, in place of the plain text field: a markdown editor with its toolbar on top, for one.
   * It is drawn inside a bordered box that also shows the invalid state, so it brings no border of its own; its
   * toolbar, inset and height are its own. `undefined` keeps the plain field.
   */
  renderInstructions?: (field: WorkflowStepInstructionsField) => ReactNode
  /** The compaction threshold, in tokens, a step takes when it sets none: shown in the empty field. */
  defaultCompactAbove?: number
  onMove: (direction: -1 | 1) => void
  onDuplicate: () => void
  onDelete: () => void
  /** A grip drawn before the step number, e.g. the one a step list hands each card to drag it by. */
  dragHandle?: ReactNode
}

function FieldIssues({ messages }: { messages?: string[] }) {
  if (!messages?.length) {
    return null
  }
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-destructive">
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  )
}

function Field({
  label,
  children,
  issues,
  hint,
  disabled,
}: {
  label: string
  children: ReactNode
  issues?: string[]
  hint?: ReactNode
  /** Disables every control in `children`; the label and hint stay readable, so the hint can say why. */
  disabled?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {disabled ? (
        <fieldset disabled className="min-w-0 opacity-60">
          {children}
        </fieldset>
      ) : (
        children
      )}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      <FieldIssues messages={issues} />
    </div>
  )
}

function PickerTrigger({ children, invalid }: { children: ReactNode; invalid?: boolean }) {
  return (
    <DropdownMenuTrigger
      render={
        <Button
          variant="outline"
          aria-invalid={invalid || undefined}
          className="w-full justify-between font-normal"
        />
      }
    >
      <span className="flex min-w-0 items-center gap-2 truncate">{children}</span>
      <ChevronDown className="text-muted-foreground" />
    </DropdownMenuTrigger>
  )
}

/**
 * One step of a workflow being edited: its name, the status that starts it,
 * and its kind. An agent step says who works it (the task's assignee, or one
 * agent of the chat its session opens in), for a fixed agent the thread it is
 * worked in (the agent's own thread on each task, or one of its existing
 * threads), the folder of that chat's thread list a thread opened for it is
 * filed in, and what the agent is told; an approval step
 * says who approves it. Both list the transitions the step may be finished by.
 * Its menu (the "more" button, or a right-click / long press on the step's
 * header) moves, copies or removes it.
 */
export function WorkflowStepCard({
  index,
  count,
  value,
  onChange,
  statuses,
  agents,
  chatName,
  threads,
  people = [],
  steps,
  derivedGate,
  issues = {},
  placeholders,
  renderInstructions,
  defaultCompactAbove,
  onMove,
  onDuplicate,
  onDelete,
  dragHandle,
}: WorkflowStepCardProps) {
  const set = (patch: Partial<WorkflowStepCardValue>) => onChange({ ...value, ...patch })
  const trigger = statuses.find((s) => s.id === value.triggerStatus)
  const agentId = value.worker.kind === "agent" ? value.worker.agentNodeId : null
  const agent = agentId ? agents.find((a) => a.nodeId === agentId) : undefined
  const agentName = agentId ? (agent?.name ?? agentId) : null
  const thread = value.worker.kind === "agent" ? value.worker.thread : undefined
  const chosenThread = thread ? threads?.find((t) => t.ref === thread) : undefined
  const chat = chatName ?? "the chat"
  const setThread = (ref: string | undefined) => {
    if (agentId) {
      // A step in a chosen thread sets nothing on that thread's session, so choosing one clears the step's settings.
      set(
        ref
          ? { worker: { kind: "agent", agentNodeId: agentId, thread: ref }, sessionOptions: {} }
          : { worker: { kind: "agent", agentNodeId: agentId } },
      )
    }
  }
  let threadHint = "Each task gets the agent’s own thread for it, opened the first time the step starts."
  if (thread && threads && !chosenThread) {
    threadHint = `Not among ${agentName}’s threads in ${chat}: the step waits until the thread is back, or another one is chosen.`
  } else if (thread) {
    threadHint = "Every task’s step is sent into this thread, after any turn running there, and comes back to it for rework. Closing a task leaves it as it is."
  }
  const sessionIssues = [
    ...(issues["sessionOptions.effort"] ?? []),
    ...(issues["sessionOptions.presence"] ?? []),
    ...(issues["sessionOptions.permissionMode"] ?? []),
  ]
  // A new object without the key rather than the key set to undefined, so an unset setting is absent from what is saved.
  const unsetSession = (key: keyof WorkflowStepCardValue["sessionOptions"]) => {
    const { [key]: _removed, ...rest } = value.sessionOptions
    set({ sessionOptions: rest })
  }
  const setSession = (patch: WorkflowStepCardValue["sessionOptions"]) => set({ sessionOptions: { ...value.sessionOptions, ...patch } })
  const issuesUnder = (prefix: string) =>
    Object.fromEntries(Object.entries(issues).flatMap(([key, messages]) => (key.startsWith(prefix) ? [[key.slice(prefix.length), messages]] : [])))
  const transitionIssues = issuesUnder("transitions.")
  const approval = value.kind === "approval"

  const menuItems = (Item: typeof ContextMenuItem | typeof DropdownMenuItem, Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator) => (
    <>
      <Item disabled={index === 0} onClick={() => onMove(-1)}>
        <ArrowUp />
        Move up
      </Item>
      <Item disabled={index === count - 1} onClick={() => onMove(1)}>
        <ArrowDown />
        Move down
      </Item>
      <Item onClick={onDuplicate}>
        <Copy />
        Duplicate
      </Item>
      <Separator />
      <Item variant="destructive" onClick={onDelete}>
        <Trash2 />
        Delete step
      </Item>
    </>
  )

  return (
    <article data-slot="workflow-step-card" className="flex flex-col gap-4 rounded-lg border bg-card p-4" aria-label={`Step ${index + 1}: ${value.name || "untitled"}`}>
      {/* The menu opens on the header only, so the fields keep the browser's own copy-and-paste menu. */}
      <ContextMenu>
        <ContextMenuTrigger render={<header className="flex items-start gap-3" />}>
          {dragHandle}
          <span className="mt-1.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
            {index + 1}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Input
              value={value.name}
              placeholder="Step name, e.g. Development"
              aria-label="Step name"
              aria-invalid={issues.name?.length ? true : undefined}
              onChange={(event) => set({ name: event.target.value })}
              className="font-medium"
            />
            <FieldIssues messages={issues.name} />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Step actions" />}>
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={MENU_SCROLL_POPUP}>
              <MenuScrollArea>{menuItems(DropdownMenuItem, DropdownMenuSeparator)}</MenuScrollArea>
            </DropdownMenuContent>
          </DropdownMenu>
        </ContextMenuTrigger>
        <ContextMenuContent className={MENU_SCROLL_POPUP}>
          <MenuScrollArea>{menuItems(ContextMenuItem, ContextMenuSeparator)}</MenuScrollArea>
        </ContextMenuContent>
      </ContextMenu>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Decided by" issues={issues.kind}>
          <div role="group" aria-label="Step kind" className="flex rounded-md border p-0.5">
            {([
              { kind: "agent", label: "An agent", icon: Bot },
              { kind: "approval", label: "Approvers", icon: ShieldCheck },
            ] as const).map((option) => (
              <Button
                key={option.kind}
                variant={value.kind === option.kind ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={value.kind === option.kind}
                className="flex-1"
                onClick={() => set({ kind: option.kind })}
              >
                <option.icon />
                {option.label}
              </Button>
            ))}
          </div>
        </Field>

        <Field label="Starts when the task enters" issues={issues.triggerStatus}>
          <DropdownMenu>
            <PickerTrigger invalid={Boolean(issues.triggerStatus?.length)}>
              {trigger ? trigger.display : <span className="text-muted-foreground">Choose a status</span>}
            </PickerTrigger>
            <DropdownMenuContent className={cn("min-w-52", MENU_SCROLL_POPUP)}>
              <MenuScrollArea>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Status</DropdownMenuLabel>
                  {statuses.map((status) => (
                    <DropdownMenuItem key={status.id} onClick={() => set({ triggerStatus: status.id })}>
                      <span className="flex-1">{status.display}</span>
                      <Check className={cn("size-4", status.id === value.triggerStatus ? "opacity-100" : "opacity-0")} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </MenuScrollArea>
            </DropdownMenuContent>
          </DropdownMenu>
        </Field>

        {approval ? null : (
          <>
            <Field
              label="Worked by"
              issues={issues.worker}
              hint={
                agentId && !agent
                  ? `Not in ${chatName ?? "the chat"}: the step waits until the agent is added to it.`
                  : undefined
              }
            >
              <DropdownMenu>
                <PickerTrigger invalid={Boolean(issues.worker?.length)}>
                  {value.worker.kind === "assignee" ? (
                    <>
                      <UserRound className="size-4 text-muted-foreground" />
                      The task’s assignee
                    </>
                  ) : (
                    <>
                      <TaskAvatarPicture
                        who={{ kind: "agent", id: agentId ?? undefined, name: agentName ?? "" }}
                        className="size-4"
                        fallback={<Bot className="size-4 text-muted-foreground" />}
                      />
                      {agentName}
                    </>
                  )}
                </PickerTrigger>
                <DropdownMenuContent className={cn("min-w-52", MENU_SCROLL_POPUP)}>
                  <MenuScrollArea>
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Who works this step</DropdownMenuLabel>
                      <DropdownMenuItem onClick={() => set({ worker: { kind: "assignee" } })}>
                        <UserRound />
                        <span className="flex-1">The task’s assignee</span>
                        <Check className={cn("size-4", value.worker.kind === "assignee" ? "opacity-100" : "opacity-0")} />
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{agents.length ? `Agents in ${chatName ?? "the chat"}` : `No agents in ${chatName ?? "the chat"} yet`}</DropdownMenuLabel>
                      {agents.map((option) => (
                        <DropdownMenuItem
                          key={option.nodeId}
                          onClick={() => {
                            if (option.nodeId !== agentId) {
                              set({ worker: { kind: "agent", agentNodeId: option.nodeId } })
                            }
                          }}
                        >
                          <TaskAvatarPicture who={{ kind: "agent", id: option.nodeId, name: option.name }} className="size-4" fallback={<Bot />} />
                          <span className="flex-1">{option.name}</span>
                          <Check className={cn("size-4", option.nodeId === agentId ? "opacity-100" : "opacity-0")} />
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </MenuScrollArea>
                </DropdownMenuContent>
              </DropdownMenu>
            </Field>

            {agentId ? (
              <Field label="Thread" issues={issues["worker.thread"]} hint={threadHint}>
                <DropdownMenu>
                  <PickerTrigger invalid={Boolean(issues["worker.thread"]?.length)}>
                    <MessagesSquare className="size-4 text-muted-foreground" />
                    {thread ? (chosenThread?.title || thread) : "Its own thread on each task"}
                  </PickerTrigger>
                  <DropdownMenuContent className={cn("min-w-52", MENU_SCROLL_POPUP)}>
                    <MenuScrollArea>
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Where the step is worked</DropdownMenuLabel>
                        <DropdownMenuItem onClick={() => setThread(undefined)}>
                          <span className="flex-1">Its own thread on each task</span>
                          <Check className={cn("size-4", thread ? "opacity-0" : "opacity-100")} />
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>
                          {threads === undefined
                            ? `Loading ${agentName}’s threads…`
                            : threads.length
                              ? `${agentName}’s threads in ${chat}`
                              : `${agentName} has no threads in ${chat} yet`}
                        </DropdownMenuLabel>
                        {(threads ?? []).map((option) => (
                          <DropdownMenuItem key={option.ref} onClick={() => setThread(option.ref)}>
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate">{option.title || option.ref}</span>
                              {option.folder ? <span className="truncate text-xs text-muted-foreground">{option.folder}</span> : null}
                            </span>
                            <Check className={cn("size-4", option.ref === thread ? "opacity-100" : "opacity-0")} />
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </MenuScrollArea>
                  </DropdownMenuContent>
                </DropdownMenu>
              </Field>
            ) : null}

            {/* A chosen thread already has its place in the chat's list: the step files nothing. */}
            {thread ? null : (
              <Field
                label="Chat folder"
                issues={issues.folder}
                hint={`The folder of ${chat}’s thread list the step’s thread goes in, by its name there. Made if it isn’t there yet.`}
              >
                <Input
                  value={value.folder}
                  placeholder="None: the top level"
                  aria-label="Chat folder"
                  aria-invalid={issues.folder?.length ? true : undefined}
                  onChange={(event) => set({ folder: event.target.value })}
                />
              </Field>
            )}

            <Field
              label="Session settings"
              issues={sessionIssues}
              disabled={Boolean(thread)}
              hint={
                thread
                  ? "The chosen thread’s session is its agent’s own: the step leaves its settings as they are."
                  : "Applied to the step’s session each time the step starts, before its message. Not set leaves the session’s own setting; a value the agent doesn’t offer is skipped. A slower presence also delays the step’s own message."
              }
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="flex items-center gap-1">
                  <EffortSelector
                    options={SESSION_EFFORTS}
                    current={value.sessionOptions.effort ?? null}
                    onSelect={(effort) => setSession({ effort })}
                    onUnset={() => unsetSession("effort")}
                  />
                  <span className="text-xs text-muted-foreground">Effort</span>
                </span>
                <span className="flex items-center gap-1">
                  <PresenceSelector
                    presence={value.sessionOptions.presence ?? null}
                    onSelect={(presence) => setSession({ presence })}
                    onUnset={() => unsetSession("presence")}
                  />
                  <span className="text-xs text-muted-foreground">Presence</span>
                </span>
                <span className="flex items-center gap-1">
                  <ModeSelector
                    options={SESSION_MODES}
                    current={value.sessionOptions.permissionMode ?? null}
                    onSelect={(permissionMode) => setSession({ permissionMode })}
                    onUnset={() => unsetSession("permissionMode")}
                  />
                  <span className="text-xs text-muted-foreground">Mode</span>
                </span>
              </div>
            </Field>

            <Field
              label="Compact the session above"
              issues={issues["sessionOptions.compactAbove"]}
              disabled={Boolean(thread)}
              hint={
                thread
                  ? "The chosen thread is never compacted by the step."
                  : "When the step comes back to a session it already has, and that session holds more context than this many tokens, it’s compacted before the step’s message, which then gives the instructions again. Empty takes the default; 0 never compacts."
              }
            >
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                step={10000}
                value={value.sessionOptions.compactAbove ?? ""}
                placeholder={defaultCompactAbove === undefined ? "Default" : `Default: ${defaultCompactAbove.toLocaleString()}`}
                aria-label="Compact the session above, in tokens"
                aria-invalid={issues["sessionOptions.compactAbove"]?.length ? true : undefined}
                onChange={(event) =>
                  event.target.value === "" ? unsetSession("compactAbove") : setSession({ compactAbove: Number(event.target.value) })
                }
              />
            </Field>
          </>
        )}
      </div>

      {approval ? (
        <Field
          label="Approvers"
          hint="Each is asked in the task manager’s notifications when the step starts. The step passes once every required approver has approved and the approvals reach the number needed; any one Reject sends the task back."
        >
          <WorkflowApproversEditor
            value={value.approval}
            onChange={(next) => set({ approval: next })}
            people={people}
            agents={agents.map((a) => ({ id: a.nodeId, name: a.name }))}
            issues={issuesUnder("approval.")}
          />
        </Field>
      ) : (
        <Field
          label="Instructions for the agent"
          issues={issues.instructions}
          hint="Sent as the session’s first message as written, with the fields filled in. Only how to finish the step is added after it, so name the task here."
        >
          <div className="flex flex-col gap-1.5">
            {renderInstructions ? (
              <div
                data-slot="workflow-step-instructions"
                role="group"
                aria-label="Instructions"
                data-invalid={issues.instructions?.length ? "" : undefined}
                className={INSTRUCTIONS_FRAME}
              >
                {renderInstructions({
                  value: value.instructions,
                  onChange: (instructions) => set({ instructions }),
                  placeholder: INSTRUCTIONS_PLACEHOLDER,
                  invalid: Boolean(issues.instructions?.length),
                })}
              </div>
            ) : (
              <Textarea
                value={value.instructions}
                rows={4}
                placeholder={INSTRUCTIONS_PLACEHOLDER}
                aria-label="Instructions"
                aria-invalid={issues.instructions?.length ? true : undefined}
                onChange={(event) => set({ instructions: event.target.value })}
                className="font-mono text-xs"
              />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="xs" className="self-start text-muted-foreground" />}>
                Insert a field
                <ChevronDown />
              </DropdownMenuTrigger>
              <DropdownMenuContent className={cn("max-h-72", MENU_SCROLL_POPUP)}>
                <MenuScrollArea>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Filled in when the step starts</DropdownMenuLabel>
                    {placeholders.map((p) => (
                      <DropdownMenuItem
                        key={p.token}
                        onClick={() => set({ instructions: `${value.instructions}${value.instructions && !value.instructions.endsWith(" ") ? " " : ""}{{ ${p.token} }}` })}
                      >
                        <span className="flex-1">{p.label}</span>
                        <code className="text-[11px] text-muted-foreground">{p.token}</code>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </MenuScrollArea>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </Field>
      )}

      <Field
        label={approval ? "The approvers finish the step by" : "When done, the agent finishes the step by"}
        issues={issues.transitions}
        hint={
          approval
            ? "Approve takes a transition that passes, Reject one that sends the task back; with several, the approver chooses. Each opens the next step (or ends the run) and moves the task to its status."
            : "The agent picks one by its label. Each opens the next step (or ends the run), moves the task to its status, and passes the step or sends the task back."
        }
      >
        <WorkflowTransitionList
          value={value.transitions}
          onChange={(transitions) => set({ transitions })}
          steps={steps}
          statuses={statuses}
          derivedGate={derivedGate}
          issues={transitionIssues}
        />
      </Field>
    </article>
  )
}
