// The notifications bell in the task manager's header: the
// signed-in person's inbox for this project, kept fresh by `tasks.inbox`
// events. The kit's `TaskInbox` renders it; this file only feeds it.

import { extensionId } from '@opencroft/client/extension'
import { getStream } from '@opencroft/client/streams'
import { Bell, BellOff, ExternalLink, MailCheck, MailOpen } from 'lucide-react'
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { TaskInbox } from '@/components/ui/notifications/task-inbox'
import type { ItemMenuEntries } from '@/components/ui/tasks/item-menu'
import {
  INBOX_EVENT,
  type InboxEvent,
  type InboxFilter,
  type InboxMarkReadInput,
  type TaskNotification,
} from '../../shared/inbox'
import { openTask, taskHref } from '../app/task-opener'
import { errorMessage, tasksApi } from '../lib/api'

/**
 * A notification's menu, wherever it is listed (the inbox, My work): open its
 * task, mark it read or unread, mute or unmute the task. The inbox's live event
 * refreshes every list after a change.
 */
export function inboxRowMenu(instanceId: string, n: TaskNotification, onOpen: (key: string) => void): ItemMenuEntries {
  const api = tasksApi(instanceId)
  const fail = (failure: unknown) => toast.error(errorMessage(failure))
  return [
    { id: 'open', label: 'Open task', icon: ExternalLink, group: 'open', onSelect: () => onOpen(n.task.key) },
    n.read
      ? {
          id: 'unread',
          label: 'Mark unread',
          icon: MailOpen,
          onSelect: () => void api.inbox_mark_unread({ ids: [n.id] }).catch(fail),
        }
      : {
          id: 'read',
          label: 'Mark read',
          icon: MailCheck,
          onSelect: () => void api.inbox_mark_read({ ids: [n.id] }).catch(fail),
        },
    n.muted
      ? {
          id: 'unmute',
          label: `Unmute ${n.task.key}`,
          icon: Bell,
          onSelect: () =>
            void api
              .inbox_mute({ task: n.task.key, muted: false })
              .then(() => toast.success(`${n.task.key} notifies you again`))
              .catch(fail),
        }
      : {
          id: 'mute',
          label: `Mute ${n.task.key}`,
          icon: BellOff,
          onSelect: () =>
            void api
              .inbox_mute({ task: n.task.key, muted: true })
              .then(() => toast.success(`Muted ${n.task.key}: nothing new about it comes to your inbox`))
              .catch(fail),
        },
  ]
}

/** One chunk of the extension's `events` stream, as the server broadcasts it. */
interface InboxEventChunk {
  name?: string
  payload?: InboxEvent
}

/** Call `onChange` when this instance's inbox changed, debounced. */
export function useInboxLive(instanceId: string | null, onChange: () => void, delayMs = 300): void {
  const callback = useRef(onChange)
  callback.current = onChange
  useEffect(() => {
    const stream = getStream<InboxEventChunk>(extensionId, 'events')
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = stream.subscribe((chunk) => {
      const event = chunk?.payload
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
  const api = useMemo(() => tasksApi(instanceId), [instanceId])
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
        const page = await api.inbox_list({ filter: wanted })
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
      const page = await api.inbox_list({ filter, before: nextBefore })
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
        setUnread((await api.inbox_mark_read(input)).unread)
      } catch (failure) {
        toast.error(errorMessage(failure))
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
