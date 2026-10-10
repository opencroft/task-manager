// The "Sessions" line on a task: every agent @mentioned in its comments, with
// when it was last mentioned, each opening its session in the same reader as
// the workflow panel's steps. Hidden until some agent has been mentioned.
//
// It loads once and then only when the task changes (a live event for its
// key): nothing polls while the page sits idle.

import { cn } from 'cn'
import { MessagesSquare } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { MentionSession } from '../../shared/mentions'
import type { TasksApi } from '../lib/api'
import { useTasksLive } from '../lib/live'
import { SessionReader } from './session-reader'

function ago(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function MentionSessions({ api, instanceId, taskKey }: { api: TasksApi; instanceId: string; taskKey: string }) {
  const [sessions, setSessions] = useState<MentionSession[]>([])
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setSessions((await api.mention_sessions({ key: taskKey })).sessions)
    } catch {
      // The line is a convenience; the comments and the chat still hold everything.
    }
  }, [api, taskKey])

  useEffect(() => {
    setOpen(null)
    void load()
  }, [load])

  useTasksLive(instanceId, (events) => {
    if (events.some((event) => event.keys.includes(taskKey))) {
      void load()
    }
  })

  if (sessions.length === 0) {
    return null
  }
  const shown = sessions.find((session) => session.agent.id === open)
  return (
    <section aria-label='Sessions' className='flex flex-col gap-2'>
      <div className='flex flex-wrap items-center gap-1.5'>
        <span className='mr-1 text-sm font-semibold'>Sessions</span>
        {sessions.map((session) => {
          const readable = Boolean(session.threadId && session.chatSlug)
          const active = session.agent.id === open
          return (
            <Button
              key={session.agent.id}
              variant={active ? 'secondary' : 'outline'}
              size='sm'
              aria-expanded={readable ? active : undefined}
              disabled={!readable}
              title={
                readable
                  ? `Open the session. Last mentioned ${new Date(session.lastAt).toLocaleString()}`
                  : (session.note ?? undefined)
              }
              onClick={() => setOpen(active ? null : session.agent.id)}
              className={cn('h-7 gap-1.5 px-2 font-normal', session.note && 'border-destructive/40')}
            >
              <MessagesSquare className='size-3.5' />
              <span className='font-medium'>{session.agent.name}</span>
              <span className='text-muted-foreground'>· {ago(session.lastAt)}</span>
            </Button>
          )
        })}
      </div>
      {sessions
        .filter((session) => session.note)
        .map((session) => (
          <p key={session.agent.id} className='text-sm text-muted-foreground'>
            <span className='font-medium text-foreground'>{session.agent.name}:</span> {session.note}
          </p>
        ))}
      {shown?.threadId && shown.chatSlug ? <SessionReader chatSlug={shown.chatSlug} threadId={shown.threadId} /> : null}
    </section>
  )
}
