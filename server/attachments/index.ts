// Seam owned by attachments. The server entry spreads `attachmentActions` into
// the `tasks` App's actions; input schemas and descriptions live in
// extension.json.

import type { AppActionContext, AppActionHandler } from '@opencroft/server'

import type {
  AttachmentActionId,
  TaskAttachInput,
  TaskAttachmentRenameInput,
} from '../../shared/attachments.ts'
import { scopeFor } from '../actions.ts'
import { attach, deleteAttachment, listAttachments, readAttachment, renameAttachment } from './store.ts'

type Params = Record<string, unknown>

const handlers: Record<AttachmentActionId, (ctx: AppActionContext, params: Params) => unknown> = {
  task_attach: (ctx, params) => attach(scopeFor(ctx), params as unknown as TaskAttachInput),
  task_attachments: (ctx, params) => ({ attachments: listAttachments(scopeFor(ctx), params.key) }),
  task_attachment_get: (ctx, params) => readAttachment(scopeFor(ctx), params.id),
  task_attachment_rename: (ctx, params) => renameAttachment(scopeFor(ctx), params as unknown as TaskAttachmentRenameInput),
  task_attachment_delete: (ctx, params) => deleteAttachment(scopeFor(ctx), params.id),
}

export const attachmentActions: Record<string, AppActionHandler> = Object.fromEntries(
  Object.entries(handlers).map(([id, handler]) => [id, (ctx: AppActionContext, params: Params) => handler(ctx, params ?? {})]),
)
