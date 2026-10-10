// The one place attachment bytes move between the browser and the server:
// the extension's session route (ATTACHMENTS_ROUTE), which the host serves
// only to a signed-in person. An upload is the file itself as the request
// body; a file is read by its URL, so the browser streams, ranges and caches
// it, and an <img> shows it without the page holding its bytes.

import { routeUrl } from '@opencroft/client/extension'

import { ATTACHMENTS_ROUTE, type TaskAttachment } from '../../shared/attachments'

export interface AttachmentTransport {
  upload(key: string, file: File): Promise<TaskAttachment>
  /** A URL showing the file's bytes: inline for a previewable image, otherwise as a download. */
  objectUrl(attachment: TaskAttachment): Promise<string>
  /** A URL that saves the file under its name, whatever its type. */
  downloadUrl(attachment: TaskAttachment): string
  /** Let go of one file's bytes, after it is deleted. Nothing is held: the browser's cache keeps them. */
  release(id: string): void
  /** Let go of every file's bytes, when the page that showed them goes. */
  releaseAll(): void
}

function attachmentsUrl(query: Record<string, string>): string {
  return `${routeUrl(ATTACHMENTS_ROUTE)}?${new URLSearchParams(query)}`
}

export function attachmentTransport(instanceId: string): AttachmentTransport {
  const fileUrl = (attachment: TaskAttachment, extra: Record<string, string> = {}) =>
    attachmentsUrl({ app: instanceId, id: attachment.id, ...extra })
  return {
    async upload(key, file) {
      const response = await fetch(attachmentsUrl({ app: instanceId, key, name: file.name }), {
        method: 'POST',
        body: file,
        credentials: 'same-origin',
      })
      const body = (await response.json().catch(() => null)) as (TaskAttachment & { error?: string }) | null
      if (!response.ok || !body) {
        throw new Error(body?.error ?? `${file.name} could not be uploaded (HTTP ${response.status})`)
      }
      return body
    },
    objectUrl: async (attachment) => fileUrl(attachment),
    downloadUrl: (attachment) => fileUrl(attachment, { download: '1' }),
    release() {},
    releaseAll() {},
  }
}
