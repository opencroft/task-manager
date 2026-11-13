import { Bot, Minus, Plus, UserPlus, X } from "lucide-react"

import { Button } from "../button"
import { Checkbox } from "../checkbox"
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
import { cn } from "cn"

/** A person who can approve, from the host's directory. */
export interface WorkflowApproverPerson {
  id: string
  name: string
}

export interface WorkflowApproverValue {
  personId: string
  name: string
  /** A required approver must approve for the step to pass. */
  required: boolean
}

/** An agent that may reject the step for one of its approvers, on that approver's word. */
export interface WorkflowRejectingAgentValue {
  agentNodeId: string
  name: string
}

/** An agent that can be listed, from the host's agents. */
export interface WorkflowRejectingAgentOption {
  id: string
  name: string
}

export interface WorkflowApprovalValue {
  approvers: WorkflowApproverValue[]
  /** Approvals that pass the step, required ones included. */
  needed: number
  /** Agents that may reject the step for an approver; they never approve. Omitted: none. */
  rejectingAgents?: WorkflowRejectingAgentValue[]
}

export interface WorkflowApproversEditorProps {
  value: WorkflowApprovalValue
  onChange: (value: WorkflowApprovalValue) => void
  /** The people who can be added: the host's directory. */
  people: WorkflowApproverPerson[]
  /** The agents that can be let reject for an approver: the host's agents. */
  agents?: WorkflowRejectingAgentOption[]
  /** Validation messages by field: `approvers`, `approvers.<index>`, `needed`, `rejectingAgents.<index>`. */
  issues?: Partial<Record<string, string[]>>
  className?: string
}

function Issues({ messages }: { messages?: string[] }) {
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

/** The fewest approvals the step can need: every required approver, and at least one. */
function leastNeeded(approvers: WorkflowApproverValue[]): number {
  return Math.max(1, approvers.filter((a) => a.required).length)
}

/**
 * Who decides an approval step and how many approvals pass it. Marking an
 * approver required raises the number needed to cover them; removing an
 * approver lowers it to what is left. The step passes once every required
 * approver approved and the approvals reach the number; one Reject sends it back.
 * Agents listed under "May reject for them" can press Reject for an approver,
 * on that approver's word; approving stays with the approvers.
 */
export function WorkflowApproversEditor({ value, onChange, people, agents = [], issues = {}, className }: WorkflowApproversEditorProps) {
  const { approvers, needed, rejectingAgents = [] } = value
  const least = leastNeeded(approvers)
  const most = Math.max(least, approvers.length)
  const available = people.filter((p) => !approvers.some((a) => a.personId === p.id))
  const availableAgents = agents.filter((a) => !rejectingAgents.some((r) => r.agentNodeId === a.id))
  const set = (next: WorkflowApproverValue[], nextNeeded = needed) =>
    onChange({ ...value, approvers: next, needed: Math.min(Math.max(nextNeeded, leastNeeded(next)), Math.max(1, next.length)) })
  const setAgents = (next: WorkflowRejectingAgentValue[]) => onChange({ ...value, rejectingAgents: next })

  return (
    <div data-slot="workflow-approvers-editor" className={cn("flex min-w-0 flex-col gap-3", className)}>
      {approvers.length > 0 ? (
        <ul className="flex min-w-0 flex-col divide-y rounded-md border" aria-label="Approvers">
          {approvers.map((approver, index) => (
            <li key={approver.personId || index} className="flex min-w-0 flex-col gap-1 px-3 py-2">
              <div className="flex min-w-0 items-center gap-3">
                <TaskAssignee assignee={{ kind: "person", id: approver.personId, name: approver.name }} withName size="sm" className="min-w-0 flex-1" />
                <label className="flex shrink-0 items-center gap-2 text-sm">
                  <Checkbox
                    checked={approver.required}
                    onCheckedChange={(checked) =>
                      set(approvers.map((a, i) => (i === index ? { ...a, required: checked === true } : a)))
                    }
                  />
                  Required
                </label>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${approver.name}`}
                  onClick={() => set(approvers.filter((_, i) => i !== index))}
                >
                  <X />
                </Button>
              </div>
              <Issues messages={issues[`approvers.${index}`]} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">No approvers yet: add the people who decide this step.</p>
      )}
      <Issues messages={issues.approvers} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={available.length === 0} />}>
            <UserPlus />
            Add approver
          </DropdownMenuTrigger>
          <DropdownMenuContent className={cn("min-w-52 max-h-72", MENU_SCROLL_POPUP)}>
            <MenuScrollArea>
              <DropdownMenuGroup>
                <DropdownMenuLabel>People</DropdownMenuLabel>
                {available.map((person) => (
                  <DropdownMenuItem key={person.id} onClick={() => set([...approvers, { personId: person.id, name: person.name, required: false }])}>
                    <TaskAssignee assignee={{ kind: "person", id: person.id, name: person.name }} withName size="sm" />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </MenuScrollArea>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Approvals needed</span>
          <Button variant="outline" size="icon-sm" aria-label="Fewer approvals" disabled={needed <= least} onClick={() => set(approvers, needed - 1)}>
            <Minus />
          </Button>
          <span className="min-w-12 text-center tabular-nums" aria-live="polite">
            {needed} of {approvers.length}
          </span>
          <Button variant="outline" size="icon-sm" aria-label="More approvals" disabled={needed >= most} onClick={() => set(approvers, needed + 1)}>
            <Plus />
          </Button>
        </div>
      </div>
      <Issues messages={issues.needed} />

      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">May reject for them</span>
          <span className="text-xs text-muted-foreground">
            Agents that can press Reject for an approver, on that approver’s word: they name the approver and quote them. Approving stays with the approvers.
          </span>
        </div>
        {rejectingAgents.length > 0 ? (
          <ul className="flex min-w-0 flex-col divide-y rounded-md border" aria-label="Agents that may reject">
            {rejectingAgents.map((agent, index) => (
              <li key={agent.agentNodeId || index} className="flex min-w-0 flex-col gap-1 px-3 py-2">
                <div className="flex min-w-0 items-center gap-3">
                  <TaskAssignee assignee={{ kind: "agent", id: agent.agentNodeId, name: agent.name }} withName size="sm" className="min-w-0 flex-1" />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${agent.name}`}
                    onClick={() => setAgents(rejectingAgents.filter((_, i) => i !== index))}
                  >
                    <X />
                  </Button>
                </div>
                <Issues messages={issues[`rejectingAgents.${index}`]} />
              </li>
            ))}
          </ul>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="self-start" disabled={availableAgents.length === 0} />}>
            <Bot />
            Add agent
          </DropdownMenuTrigger>
          <DropdownMenuContent className={cn("min-w-52 max-h-72", MENU_SCROLL_POPUP)}>
            <MenuScrollArea>
              <DropdownMenuGroup>
                <DropdownMenuLabel>Agents</DropdownMenuLabel>
                {availableAgents.map((agent) => (
                  <DropdownMenuItem key={agent.id} onClick={() => setAgents([...rejectingAgents, { agentNodeId: agent.id, name: agent.name }])}>
                    <TaskAssignee assignee={{ kind: "agent", id: agent.id, name: agent.name }} withName size="sm" />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </MenuScrollArea>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
