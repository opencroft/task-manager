// Files attached to a task: the shapes the attachment actions take and return.

import type { Actor, TaskKey } from './types.ts'

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

export interface TaskAttachInput {
  key: TaskKey
  name: string
  /** The file's bytes, base64. A `data:<type>;base64,` prefix is accepted and ignored. */
  contentBase64: string
}

export interface TaskAttachmentsInput {
  key: TaskKey
}

export interface TaskAttachmentGetInput {
  id: string
}

export interface TaskAttachmentRenameInput {
  id: string
  name: string
}

export interface TaskAttachmentDeleteInput {
  id: string
}

export interface AttachmentActionMap {
  task_attach: { input: TaskAttachInput; output: TaskAttachment }
  task_attachments: { input: TaskAttachmentsInput; output: { attachments: TaskAttachment[] } }
  task_attachment_get: { input: TaskAttachmentGetInput; output: { attachment: TaskAttachment; contentBase64: string } }
  task_attachment_rename: { input: TaskAttachmentRenameInput; output: TaskAttachment }
  task_attachment_delete: { input: TaskAttachmentDeleteInput; output: { deleted: string } }
}

export type AttachmentActionId = keyof AttachmentActionMap
