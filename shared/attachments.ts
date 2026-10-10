// Files attached to a task: the shapes the attachment actions return.

import type { ActionInputs } from './action-inputs.ts'
import type { Actor } from './types.ts'

/**
 * The largest file one attachment may hold. People's files stream to and from
 * disk over the extension's session route (`ATTACHMENTS_ROUTE`); agents' still
 * travel base64 through the App actions, under the same limit.
 */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

/**
 * The extension's HTTP route for attachment bytes, served to signed-in people
 * only, at `/api/ext/<extension>/http/attachments`. Everything variable is in
 * the query: `app` (the instance) and `id` to read a file, with `download=1`
 * to save rather than show it; `app`, `key` and `name` to upload one, with the
 * file as the request body.
 */
export const ATTACHMENTS_ROUTE = 'attachments'

export interface TaskAttachment {
  id: string
  name: string
  /** Bytes. */
  size: number
  /** The type the server decided from the bytes and the name; never taken from the uploader. */
  contentType: string
  /** True only for raster images the UI may show inline: PNG, JPEG, GIF and WebP. */
  previewable: boolean
  createdAt: string
  uploader: Actor
}

export interface AttachmentActionMap {
  task_attach: { input: ActionInputs['task_attach']; output: TaskAttachment }
  task_attachments: { input: ActionInputs['task_attachments']; output: { attachments: TaskAttachment[] } }
  task_attachment_get: {
    input: ActionInputs['task_attachment_get']
    output: { attachment: TaskAttachment; contentBase64: string }
  }
  task_attachment_rename: { input: ActionInputs['task_attachment_rename']; output: TaskAttachment }
  task_attachment_delete: { input: ActionInputs['task_attachment_delete']; output: { deleted: string } }
}

export type AttachmentActionId = keyof AttachmentActionMap
