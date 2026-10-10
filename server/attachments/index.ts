// Seam owned by attachments. The server entry spreads `attachmentActions` into
// the `tasks` App's actions; input schemas and descriptions live in
// extension.json.

import type { AttachmentActionId } from '../../shared/attachments.ts'
import { scopedActions } from '../actions.ts'
import { attach, deleteAttachment, listAttachments, readAttachment, renameAttachment } from './store.ts'

export const attachmentActions = scopedActions<AttachmentActionId>({
  task_attach: (scope, input) => attach(scope, input),
  task_attachments: (scope, input) => ({ attachments: listAttachments(scope, input.key) }),
  task_attachment_get: (scope, input) => readAttachment(scope, input.id),
  task_attachment_rename: (scope, input) => renameAttachment(scope, input),
  task_attachment_delete: (scope, input) => deleteAttachment(scope, input.id),
})
