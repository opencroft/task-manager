// A task's attachments as its page holds them: the list, the files on their
// way up, the images fetched for display, and what the kit's section and the
// comment composer call back with. The page's own reload is independent; this
// reloads the list whenever the task changes.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { TaskAttachment as SectionAttachment, TaskAttachmentUpload } from '@/components/ui/tasks/task-attachments'
import { ATTACHMENT_MAX_BYTES, type TaskAttachment } from '../../shared/attachments'
import { errorMessage, type TasksApi } from '../lib/api'
import { useTasksLive } from '../lib/live'
import { attachmentImageMarkdown } from './comment-images'
import { attachmentTransport } from './transport'

function saveAs(url: string, name: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export function useTaskAttachments(api: TasksApi, instanceId: string, taskKey: string) {
  const transport = useMemo(() => attachmentTransport(instanceId), [instanceId])
  useEffect(() => () => transport.releaseAll(), [transport])

  const [attachments, setAttachments] = useState<TaskAttachment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [uploads, setUploads] = useState<TaskAttachmentUpload[]>([])
  const [previews, setPreviews] = useState<Record<string, string>>({})
  // The file behind each upload, for Retry; and uploads dismissed while still in flight.
  const files = useRef(new Map<string, File>())
  const dismissed = useRef(new Set<string>())

  const load = useCallback(async () => {
    try {
      setAttachments((await api.task_attachments({ key: taskKey })).attachments)
      setError(null)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }, [api, taskKey])

  useEffect(() => {
    void load()
  }, [load])

  useTasksLive(instanceId, (events) => {
    if (events.some((event) => event.keys.includes(taskKey))) {
      void load()
    }
  })

  // Images are fetched once the list shows them, one at a time, and kept for the page's life.
  useEffect(() => {
    const waiting = (attachments ?? []).filter((a) => a.previewable && !previews[a.id])
    const next = waiting[0]
    if (!next) {
      return
    }
    let live = true
    transport
      .objectUrl(next)
      .then((url) => live && setPreviews((current) => ({ ...current, [next.id]: url })))
      .catch(() => {
        // The thumbnail keeps its placeholder; a download still fetches on demand.
      })
    return () => {
      live = false
    }
  }, [attachments, previews, transport])

  const send = useCallback(
    (id: string) => {
      const file = files.current.get(id)
      if (!file) {
        return
      }
      setUploads((current) => current.map((upload) => (upload.id === id ? { ...upload, error: null } : upload)))
      transport
        .upload(taskKey, file)
        .then(async (attachment) => {
          files.current.delete(id)
          if (dismissed.current.delete(id)) {
            // Cancelled while it travelled: the server has it, so take it back off.
            await api.task_attachment_delete({ id: attachment.id }).catch(() => {})
            return
          }
          setUploads((current) => current.filter((upload) => upload.id !== id))
          await load()
        })
        .catch((failure) => {
          if (dismissed.current.delete(id)) {
            files.current.delete(id)
            return
          }
          setUploads((current) =>
            current.map((upload) => (upload.id === id ? { ...upload, error: errorMessage(failure) } : upload)),
          )
        })
    },
    [api, load, taskKey, transport],
  )

  const onUpload = useCallback(
    (picked: File[]) => {
      const added = picked.map((file) => {
        const id = crypto.randomUUID()
        files.current.set(id, file)
        return { id, name: file.name, size: file.size, progress: null, error: null }
      })
      setUploads((current) => [...current, ...added])
      for (const upload of added) {
        send(upload.id)
      }
    },
    [send],
  )

  const onDismissUpload = useCallback(
    (id: string) => {
      const upload = uploads.find((item) => item.id === id)
      if (upload && !upload.error) {
        dismissed.current.add(id)
      } else {
        files.current.delete(id)
      }
      setUploads((current) => current.filter((item) => item.id !== id))
    },
    [uploads],
  )

  const byId = useMemo(() => new Map((attachments ?? []).map((a) => [a.id, a])), [attachments])

  const section = {
    attachments: (attachments ?? []).map(
      (a): SectionAttachment => ({ ...a, url: null, previewUrl: a.previewable ? (previews[a.id] ?? null) : null }),
    ),
    uploads,
    maxSize: ATTACHMENT_MAX_BYTES,
    loading: attachments === null && error === null,
    error: attachments === null ? error : null,
    onRetry: () => void load(),
    onUpload,
    onRetryUpload: send,
    onDismissUpload,
    onRename: async (id: string, name: string) => {
      try {
        await api.task_attachment_rename({ id, name })
      } catch (failure) {
        throw new Error(errorMessage(failure))
      }
      await load()
    },
    onDelete: async (id: string) => {
      try {
        await api.task_attachment_delete({ id })
      } catch (failure) {
        throw new Error(errorMessage(failure))
      }
      transport.release(id)
      await load()
    },
    onDownload: (attachment: SectionAttachment) => {
      const stored = byId.get(attachment.id)
      if (stored) {
        saveAs(transport.downloadUrl(stored), stored.name)
      }
    },
  }

  return {
    section,
    count: attachments?.length ?? 0,
    /** For the comment composer: uploads a pasted image and returns the markdown that shows it. */
    pasteImage: async (file: File) => {
      try {
        const attachment = await transport.upload(taskKey, file)
        void load()
        return attachmentImageMarkdown(attachment.id, attachment.name)
      } catch (failure) {
        throw new Error(errorMessage(failure))
      }
    },
    /** The stored attachment behind a comment's reference, if it still exists. */
    attachment: (id: string) => byId.get(id),
    /** The image's object URL, once fetched for display. */
    preview: (id: string) => previews[id] ?? null,
  }
}
