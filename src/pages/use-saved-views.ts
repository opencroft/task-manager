// Saved views for a page whose filters live in the URL (Tasks and Board). A
// view is the URL's filters, sort, grouping (Board) and columns (Tasks) stored
// under a name; the view being shown is the URL's `view` parameter, so a link
// keeps it too. The URL is read against the shown view (./view-state), so a
// bare `?view=<id>` link shows the view.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { TaskSavedViewsProps } from '@/components/ui/tasks/task-saved-views'
import type { SavedView, ViewPage } from '../../shared/views'
import { useProject } from '../app/project'
import { hrefFor, navigate, type TasksLocation } from '../lib/router'
import { isDefaultColumns } from './task-columns'
import {
  emptyState,
  queryOfState,
  queryOfView,
  sameViewState,
  stateOfView,
  type ViewState,
  viewOfQuery,
} from './view-state'

export interface SavedViews {
  /** The saved-views picker's props. */
  picker: TaskSavedViewsProps
  /** What the page shows, read from the URL against `base`. */
  current: ViewState
  /** What a URL that leaves something out shows of it: the shown view's state, or the empty one. Write against it. */
  base: ViewState
}

/**
 * The saved-views picker for `page`, wired: listing, choosing, saving the
 * current filters, and the owner's edits. On a visit with nothing in the URL,
 * the caller's default view opens.
 */
export function useSavedViews(page: ViewPage, location: TasksLocation): SavedViews {
  const { api, fail, confirm } = useProject()
  const [views, setViews] = useState<SavedView[]>([])
  const opened = useRef(false)

  // The page's own path, so a view shown on one board stays on that board.
  const path = location.segments.join('/')
  const show = useCallback(
    (view: SavedView) => navigate(hrefFor(path.split('/'), queryOfView(view)), { replace: true }),
    [path],
  )

  const load = useCallback(async () => {
    try {
      const next = await api.view_list({ page })
      setViews(next)
      return next
    } catch (error) {
      fail(error)
      return null
    }
  }, [api, fail, page])

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `load` alone, so the default applies on the first load only, not as the URL changes
  useEffect(() => {
    void load().then((loaded) => {
      // The default opens once, on arrival at a bare page; a link with filters is kept as it is.
      if (!opened.current && loaded && location.query.toString() === '') {
        const preferred = loaded.find((view) => view.isDefault)
        if (preferred) {
          show(preferred)
        }
      }
      opened.current = true
    })
  }, [load])

  const activeId = location.query.get('view')
  const active = views.find((view) => view.id === activeId) ?? null
  const base = useMemo(() => (active ? stateOfView(active) : emptyState(page)), [active, page])
  const current = useMemo(() => viewOfQuery(location.query, page, base), [location.query, page, base])
  const modified = active !== null && !sameViewState(current, stateOfView(active))
  // The default set is stored as none, so the view follows the default if it changes.
  const saved = { ...current, columns: current.columns && isDefaultColumns(current.columns) ? null : current.columns }

  const run = useCallback(
    async (change: () => Promise<unknown>) => {
      try {
        await change()
      } catch (error) {
        fail(error)
      }
      return load()
    },
    [fail, load],
  )

  const picker: TaskSavedViewsProps = {
    // The picker names the owner only of someone else's view.
    views: views.map((view) => (view.editable ? { ...view, owner: undefined } : view)),
    activeId: active?.id ?? null,
    modified,
    onSelect: (id) => {
      const view = views.find((candidate) => candidate.id === id)
      if (view) {
        show(view)
      }
    },
    onSaveAs: (name, shared) => void run(async () => show(await api.view_save({ name, page, shared, ...saved }))),
    onSave: active ? () => void run(() => api.view_save({ id: active.id, ...saved })) : undefined,
    onReset: active ? () => show(active) : undefined,
    onRename: (id, name) => void run(() => api.view_save({ id, name })),
    // Deleting a shared view takes it from everyone, so it asks first.
    onDelete: (id) => {
      const view = views.find((candidate) => candidate.id === id)
      confirm({
        title: `Delete the view "${view?.name ?? ''}"?`,
        description: view?.shared
          ? 'It is shared, so it goes for everyone in the project. The tasks stay as they are.'
          : 'The tasks stay as they are.',
        action: 'Delete view',
        destructive: true,
        onConfirm: () =>
          run(async () => {
            await api.view_delete({ view: id })
            // The list stays as it was: what the view held is written out, since no view stands behind the URL any more.
            if (id === activeId) {
              navigate(hrefFor(location.segments, queryOfState(current, emptyState(page))), { replace: true })
            }
          }),
      })
    },
    onSetDefault: (id) =>
      void run(() => api.view_set_default({ page, view: views.find((view) => view.id === id)?.isDefault ? null : id })),
    onSharedChange: (id, shared) => void run(() => api.view_save({ id, shared })),
  }
  return { picker, current, base }
}
