// The space's chat, where every workflow step, mention session and the project
// chat open their threads: which chat it is, whether the task manager may open
// threads there, and which agents it can reach. The task manager never creates
// the chat or adds members; a person in the chat can let it in from here.

import { Check } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'

import type { SpaceChatState } from '../../shared/workflows'
import { useProject } from '../app/project'
import { errorMessage } from '../lib/api'
import { workflowsApi } from '../workflows/api'

/** The host's page for a group chat, by its id. */
const chatHref = (ref: string) => `/group-chats/${encodeURIComponent(ref)}`

export function SpaceChatStatus() {
  const { instanceId, fail } = useProject()
  const workflows = useMemo(() => workflowsApi(instanceId), [instanceId])
  const [state, setState] = useState<SpaceChatState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setState(await workflows.space_chat({}))
      setError(null)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }, [workflows])

  useEffect(() => {
    void load()
  }, [load])

  const grant = async () => {
    setBusy(true)
    try {
      setState(await workflows.space_chat_grant({}))
    } catch (failure) {
      fail(failure)
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>
  }
  if (!state) {
    return <p className="text-sm text-muted-foreground">Loading the space's chat…</p>
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-1 rounded-md border px-3 py-2">
        {state.name && state.ref ? (
          <p>
            Threads open in{' '}
            <a href={chatHref(state.ref)} className="font-medium text-primary underline-offset-4 hover:underline">
              {state.name}
            </a>
            , the chat of this space (<span className="font-mono">{state.slug}</span>).
          </p>
        ) : (
          <p>
            Threads open in the chat of this space, at <span className="font-mono">{state.slug}</span>. Neither you nor the task manager is in it
            yet: open the chat from the title bar to join it, or to create it if the space has none.
          </p>
        )}
        {state.taskManagerIn ? (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Check aria-hidden="true" className="size-4 text-primary" /> The task manager can open threads there.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-0 flex-1 text-muted-foreground">
              The task manager isn't in it yet, so workflow steps and mentions wait with that reason.
              {state.youAreIn === false ? ' Join the chat first to let it in, or ask one of its members.' : ''}
            </p>
            {state.youAreIn ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void grant()}>
                Let the task manager in
              </Button>
            ) : null}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-medium">Agents it can reach</p>
        {state.agents.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {state.agents.map((agent) => (
              <li key={agent.nodeId} className="rounded-md border px-2 py-0.5 text-xs">
                {agent.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">No agents that the task manager or you can see.</p>
        )}
        <p className="text-xs text-muted-foreground">
          A workflow step or a mention reaches only an agent in this chat; any other one waits with "&lt;agent&gt; isn't in this space's chat". Add
          agents in the chat's members.
        </p>
      </div>
    </div>
  )
}
