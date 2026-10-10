// Seam owned by project settings. The server entry spreads `settingsActions`
// into the `tasks` App's actions: the project's name and key, and its labels
// as a managed set.

import type { SettingsActionId } from '../../shared/settings.ts'
import { projectKeyOf, scopedActions } from '../actions.ts'
import { colorLabel, deleteLabel, labelOverview, mergeLabel, renameLabel } from './labels.ts'

export const settingsActions = scopedActions<SettingsActionId>({
  project_info: ({ inv: { ctx } }) => ({
    name: ctx.name,
    key: projectKeyOf(ctx.params),
    address: `${ctx.spaceSlug}.${ctx.slug}`,
    space: ctx.spaceSlug,
  }),
  label_overview: (scope) => ({ labels: labelOverview(scope) }),
  label_rename: (scope, input) => renameLabel(scope, input),
  label_merge: (scope, input) => mergeLabel(scope, input),
  label_delete: (scope, input) => deleteLabel(scope, input),
  label_color: (scope, input) => colorLabel(scope, input),
})
