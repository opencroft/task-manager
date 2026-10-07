// Seam owned by project settings. The server entry spreads `settingsActions`
// into the `tasks` App's actions: the project's name and key, and its labels
// as a managed set.

import type { AppActionContext, AppActionHandler } from '@opencroft/server'

import type { SettingsActionId } from '../../shared/settings.ts'
import { projectKeyOf, scopeFor } from '../actions.ts'
import { colorLabel, deleteLabel, labelOverview, mergeLabel, renameLabel } from './labels.ts'

const handlers: Record<SettingsActionId, (ctx: AppActionContext, params: Record<string, unknown>) => unknown> = {
  project_info: (ctx) => ({ name: ctx.name, key: projectKeyOf(ctx.params), address: `${ctx.spaceSlug}.${ctx.slug}`, space: ctx.spaceSlug }),
  label_overview: (ctx) => ({ labels: labelOverview(scopeFor(ctx)) }),
  label_rename: (ctx, params) => renameLabel(scopeFor(ctx), params),
  label_merge: (ctx, params) => mergeLabel(scopeFor(ctx), params),
  label_delete: (ctx, params) => deleteLabel(scopeFor(ctx), params),
  label_color: (ctx, params) => colorLabel(scopeFor(ctx), params),
}

export const settingsActions: Record<string, AppActionHandler> = Object.fromEntries(
  Object.entries(handlers).map(([id, handler]) => [id, (ctx: AppActionContext, params: Record<string, unknown>) => handler(ctx, params ?? {})]),
)
