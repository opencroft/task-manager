// The notifications bell in the task manager's header: the
// signed-in person's inbox for this project, kept fresh by `tasks.inbox`
// events. The kit's `TaskInbox` renders it; this file only feeds it.

import { callAppAction, legacy } from '@opencroft/client'
import { Bell, BellOff, ExternalLink, MailCheck, MailOpen } from 'lucide-react'
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { TaskInbox } from '@/components/ui/notifications/task-inbox'
import type { ItemMenuEntries } from '@/components/ui/tasks/item-menu'

import {
  INBOX_EVENT,
  type InboxEvent,
  type InboxFilter,
  type InboxListInput,
  type InboxListResult,
  type InboxMarkReadInput,
  type InboxMarkUnreadInput,
  type InboxMuteInput,
  type TaskNotification,
} from '../../shared/inbox'
import { openTask, taskHref } from '../app/task-opener'
import { errorMessage, withFullDetail } from '../lib/api'

function inboxApi(instanceId: string) {
  return {
    list: (input: InboxListInput) => callAppAction<InboxListResult>(instanceId, 'inbox_list', withFullDetail('inbox_list', { ...input })),
    markRead: (input: InboxMarkReadInput) => callAppAction<{ unread: number }>(instanceId, 'inbox_mark_read', { ...input }),
    markUnread: (input: InboxMarkUnreadInput) => callAppAction<{ unread: number }>(instanceId, 'inbox_mark_unread', { ...input }),
    mute: (input: InboxMuteInput) => callAppAction<{ task: string; muted: boolean }>(instanceId, 'inbox_mute', { ...input }),
  }
}

/**
 * A notification's menu, wherever it is listed (the inbox, My work): open its
 * task, mark it read or unread, mute or unmute the task. The inbox's live event
 * refreshes every list after a change.
 */
export function inboxRowMenu(instanceId: string, n: TaskNotification, onOpen: (key: string) => void): ItemMenuEntries {
  const api = inboxApi(instanceId)
  const fail = (failure: unknown) => legacy.toast.error(errorMessage(failure))
  return [
    { id: 'open', label: 'Open task', icon: ExternalLink, group: 'open', onSelect: () => onOpen(n.task.key) },
    n.read
      ? { id: 'unread', label: 'Mark unread', icon: MailOpen, onSelect: () => void api.markUnread({ ids: [n.id] }).catch(fail) }
      : { id: 'read', label: 'Mark read', icon: MailCheck, onSelect: () => void api.markRead({ ids: [n.id] }).catch(fail) },
    n.muted
      ? {
          id: 'unmute',
          label: `Unmute ${n.task.key}`,
          icon: Bell,
          onSelect: () =>
            void api
              .mute({ task: n.task.key, muted: false })
              .then(() => legacy.toast.success(`${n.task.key} notifies you again`))
              .catch(fail),
        }
      : {
          id: 'mute',
          label: `Mute ${n.task.key}`,
          icon: BellOff,
          onSelect: () =>
            void api
              .mute({ task: n.task.key, muted: true })
              .then(() => legacy.toast.success(`Muted ${n.task.key}: nothing new about it comes to your inbox`))
              .catch(fail),
        },
  ]
}

interface EventStream {
  subscribe(fn: (chunk: { name?: string; payload?: Record<string, unknown> }) => void): () => void
}

/** Call `onChange` when this instance's inbox changed, debounced. */
export function useInboxLive(instanceId: string | null, onChange: () => void, delayMs = 300): void {
  const callback = useRef(onChange)
  callback.current = onChange
  useEffect(() => {
    const stream = legacy.getStream(legacy.extensionId, 'events') as unknown as EventStream
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = stream.subscribe((chunk) => {
      const event = chunk?.payload as unknown as InboxEvent | undefined
      if (chunk?.name !== INBOX_EVENT || !event || (instanceId !== null && event.instanceId !== instanceId)) {
        return
      }
      clearTimeout(timer)
      timer = setTimeout(() => callback.current(), delayMs)
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [instanceId, delayMs])
}

// The header owns the inbox; a page opens it through this signal rather than
// holding a second copy of the list.
const openRequests = new EventTarget()

/** Open the header's inbox of this App instance. */
export function openInbox(instanceId: string): void {
  openRequests.dispatchEvent(new CustomEvent<string>('open', { detail: instanceId }))
}

export function ProjectInbox({ instanceId }: { instanceId: string }) {
  const api = useMemo(() => inboxApi(instanceId), [instanceId])
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<InboxFilter>('all')
  const [items, setItems] = useState<TaskNotification[]>([])
  const [unread, setUnread] = useState(0)
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Answers to an older filter or refresh are dropped once a newer one was asked.
  const request = useRef(0)

  const load = useCallback(
    async (wanted: InboxFilter) => {
      const id = ++request.current
      try {
        const page = await api.list({ filter: wanted })
        if (id === request.current) {
          setItems(page.items)
          setUnread(page.unread)
          setNextBefore(page.nextBefore)
          setError(null)
        }
      } catch (failure) {
        if (id === request.current) {
          setError(errorMessage(failure))
        }
      } finally {
        if (id === request.current) {
          setLoading(false)
        }
      }
    },
    [api],
  )

  useEffect(() => {
    setLoading(true)
    void load(filter)
  }, [load, filter])

  useInboxLive(instanceId, () => void load(filter))

  useEffect(() => {
    const onOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail === instanceId) {
        setOpen(true)
        void load(filter)
      }
    }
    openRequests.addEventListener('open', onOpen)
    return () => openRequests.removeEventListener('open', onOpen)
  }, [instanceId, load, filter])

  const loadMore = useCallback(async () => {
    if (!nextBefore) {
      return
    }
    const id = request.current
    setLoadingMore(true)
    try {
      const page = await api.list({ filter, before: nextBefore })
      if (id === request.current) {
        setItems((current) => [...current, ...page.items])
        setUnread(page.unread)
        setNextBefore(page.nextBefore)
        setError(null)
      }
    } catch (failure) {
      if (id === request.current) {
        setError(errorMessage(failure))
      }
    } finally {
      setLoadingMore(false)
    }
  }, [api, filter, nextBefore])

  const markRead = useCallback(
    async (input: InboxMarkReadInput) => {
      const ids = 'ids' in input ? new Set(input.ids) : null
      setItems((current) => current.map((n) => (!ids || ids.has(n.id) ? { ...n, read: true } : n)))
      try {
        setUnread((await api.markRead(input)).unread)
      } catch (failure) {
        legacy.toast.error(errorMessage(failure))
        void load(filter)
      }
    },
    [api, filter, load],
  )

  return (
    <TaskInbox
      items={items}
      unread={unread}
      filter={filter}
      onFilterChange={setFilter}
      loading={loading}
      error={error}
      onRetry={() => void load(filter)}
      hasMore={nextBefore !== null}
      loadingMore={loadingMore}
      onLoadMore={() => void loadMore()}
      onMarkRead={(ids) => void markRead({ ids })}
      onMarkAllRead={() => void markRead({ all: true })}
      getHref={(n: TaskNotification) => taskHref(n.task.key)}
      onOpen={(n: TaskNotification, event: MouseEvent<HTMLElement>) => {
        // A modified click opens the link where the browser puts it; a plain one routes here.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) {
          return
        }
        event.preventDefault()
        openTask(n.task.key)
      }}
      open={open}
      rowMenu={(n: TaskNotification) =>
        inboxRowMenu(instanceId, n, (key) => {
          setOpen(false)
          openTask(key)
        })
      }
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          void load(filter)
        }
      }}
    />
  )
}
