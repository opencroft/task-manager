// The App's one keyboard handler. The keys are the kit's shortcut set; the
// shell decides what each does with what the current page registers through
// `usePageShortcuts`, so no page binds keys of its own. It also owns the
// command palette and the shortcuts dialog, and the selection the keys act on.

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import {
  KeyboardShortcutsDialog,
  resolveShortcutPlatform,
  TASK_MANAGER_SHORTCUTS,
} from '@/components/ui/navigation/keyboard-shortcuts-dialog'
import {
  TaskCommandPalette,
  type TaskCommandPalettePage,
  type TaskCommandPaletteView,
  type TaskCommandPaletteWorkflow,
} from '@/components/ui/navigation/task-command-palette'
import type { TaskSummary } from '../../shared/types'
import { useElsewhereSearch } from '../lib/elsewhere'
import { useTasksLive } from '../lib/live'
import { hrefFor, navigate, useTasksLocation } from '../lib/router'
import { listAllTasks } from '../lib/task-list'
import { workflowsApi } from '../workflows/api'
import { chordOf, createKeyMatcher } from './key-sequences'
import { useProject } from './project'
import { DEFAULT_ROUTE, routes } from './routes'
import { closePeek, openTask, openTaskIn, peekKeyOf } from './task-opener'

/** What the current page offers the keys. Everything is optional. */
export interface PageShortcuts {
  /** Focus the page's search. Without it, `/` opens the command palette. */
  onSearch?: () => void
  /** Create a task typed into the palette where this page puts new ones; resolves to its key. */
  createTask?: (summary: string) => Promise<string>
  /** Edit the target task's summary in place. Without it, `E` opens the task with its summary in edit mode. */
  onEditSummary?: () => void
}

export interface TaskSelection {
  /** The task J and K have moved to, which the keys act on. */
  selectedKey: string | null
  select: (key: string | null) => void
  /** Moves the selection to the next or previous task on screen, as J and K do. */
  move: (step: 1 | -1) => void
}

interface ShortcutsContextValue extends TaskSelection {
  register: (page: PageShortcuts | null) => void
}

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null)

/**
 * Tell the shell what this page offers, and read the selection. A page marks
 * each element that stands for a task with `data-task-key`; J and K move
 * through those in on-screen order.
 */
export function usePageShortcuts(page: PageShortcuts = {}): TaskSelection {
  const { register, ...selection } = useShortcutsContext()
  useEffect(() => register(page))
  useEffect(() => () => register(null), [register])
  return selection
}

/** The selection alone, for what is not a page (the peek). */
export function useTaskSelection(): TaskSelection {
  const { register: _, ...selection } = useShortcutsContext()
  return selection
}

function useShortcutsContext(): ShortcutsContextValue {
  const context = useContext(ShortcutsContext)
  if (!context) {
    throw new Error('Task shortcuts outside ShortcutsProvider')
  }
  return context
}

const PAGE_OF: Record<string, TaskCommandPalettePage> = {
  'go-my-work': 'my-work',
  'go-tasks': 'tasks',
  'go-board': 'board',
  'go-timeline': 'timeline',
  'go-workflows': 'workflows',
}
const VIEW_OF: Record<string, TaskCommandPaletteView> = { status: 'status', assignee: 'assignee', priority: 'priority' }
const RECENT_LIMIT = 10

/** Focus is in something that takes typing, or in an open dialog or menu, where keys are its own. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return (
    target.isContentEditable ||
    target.closest(
      'input, textarea, select, [role="textbox"], [role="combobox"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
    ) !== null
  )
}

function readRecent(storageKey: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

/** The task elements the page marks, one per key, in document order. */
function taskKeysOnScreen(root: HTMLElement): { key: string; element: HTMLElement }[] {
  const seen = new Set<string>()
  const found: { key: string; element: HTMLElement }[] = []
  for (const element of root.querySelectorAll<HTMLElement>('[data-task-key]')) {
    const key = element.dataset.taskKey
    if (key && !seen.has(key) && element.getClientRects().length > 0) {
      seen.add(key)
      found.push({ key, element })
    }
  }
  return found
}

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const { api, instanceId, statuses, assignees, fail, menuFor } = useProject()
  const location = useTasksLocation()
  const rootRef = useRef<HTMLDivElement>(null)
  const page = useRef<PageShortcuts | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [palette, setPalette] = useState<{ open: boolean; view: TaskCommandPaletteView }>({ open: false, view: 'root' })
  // What is typed in the palette's search, for asking the other projects.
  const [paletteQuery, setPaletteQuery] = useState('')
  const elsewhere = useElsewhereSearch(paletteQuery, palette.open)
  const [helpOpen, setHelpOpen] = useState(false)
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null)
  const [workflows, setWorkflows] = useState<TaskCommandPaletteWorkflow[]>([])
  const recentKey = `tasks:${instanceId}:recent`
  const [recentKeys, setRecentKeys] = useState(() => readRecent(recentKey))
  const lastList = useRef(hrefFor([DEFAULT_ROUTE]))

  const [section, openKey] = location.segments
  const taskKey = section === 'task' && openKey ? openKey.toUpperCase() : null
  const peekKey = peekKeyOf(location)
  const currentPage = routes.some((route) => route.id === section) ? (section as TaskCommandPalettePage) : undefined
  // On a task's page the keys act on that task; on a list, on the selection.
  const targetKey = taskKey ?? selectedKey

  // The last list shown is where Esc on a task returns to.
  useEffect(() => {
    if (!taskKey && location.segments.length > 0) {
      lastList.current = hrefFor(location.segments, location.query)
    }
  }, [location, taskKey])

  // Opening a task selects it, so the list shows where you were when you come back.
  useEffect(() => {
    if (!taskKey) {
      return
    }
    setSelectedKey(taskKey)
    setRecentKeys((previous) => {
      const next = [taskKey, ...previous.filter((key) => key !== taskKey)].slice(0, RECENT_LIMIT)
      localStorage.setItem(recentKey, JSON.stringify(next))
      return next
    })
  }, [taskKey, recentKey])

  // The task in the peek is the selection, so J and K go on from it…
  useEffect(() => {
    if (peekKey) {
      setSelectedKey(peekKey)
    }
  }, [peekKey])

  // …and while the peek is open, it shows the task the selection moves to.
  const followed = useRef(selectedKey)
  useEffect(() => {
    if (selectedKey === followed.current) {
      return
    }
    followed.current = selectedKey
    if (peekKey && selectedKey && selectedKey !== peekKey) {
      openTask(selectedKey)
    }
  }, [selectedKey, peekKey])

  const loadPaletteData = useCallback(async () => {
    try {
      const [list, defs] = await Promise.all([listAllTasks(api), workflowsApi(instanceId).workflows_list({})])
      setTasks(list)
      setWorkflows(defs.workflows.map((wf) => ({ id: wf.id, name: wf.name, isDefault: wf.isDefault })))
    } catch (error) {
      fail(error)
    }
  }, [api, instanceId, fail])

  // The palette searches the whole project; its list is fetched on opening and kept fresh while open.
  useTasksLive(instanceId, () => {
    if (palette.open) {
      void loadPaletteData()
    }
  })

  const openPalette = useCallback(
    async (view: TaskCommandPaletteView) => {
      setHelpOpen(false)
      const loading = loadPaletteData()
      // A list of choices for the target task needs the task first, to check its current value.
      if (view !== 'root' && view !== 'create' && tasks === null) {
        await loading
      }
      setPalette({ open: true, view })
    },
    [loadPaletteData, tasks],
  )

  const createTask = useCallback(
    async (summary: string) => {
      try {
        const key = page.current?.createTask
          ? await page.current.createTask(summary)
          : (await api.task_create({ summary })).result.key
        toast.success(`Created ${key}`, { action: { label: 'Open', onClick: () => openTask(key) } })
      } catch (error) {
        fail(error)
      }
    },
    [api, fail],
  )

  const moveSelection = useCallback(
    (step: 1 | -1) => {
      const root = rootRef.current
      if (!root) {
        return
      }
      const onScreen = taskKeysOnScreen(root)
      if (onScreen.length === 0) {
        return
      }
      const index = onScreen.findIndex((entry) => entry.key === selectedKey)
      const next =
        index < 0 ? (step === 1 ? 0 : onScreen.length - 1) : Math.min(onScreen.length - 1, Math.max(0, index + step))
      setSelectedKey(onScreen[next].key)
      onScreen[next].element.scrollIntoView({ block: 'nearest' })
    },
    [selectedKey],
  )

  const run = useCallback(
    (ids: string[]): boolean => {
      // One key can mean different things on a list and on a task's page (E, S, A, P, Esc).
      const id =
        (taskKey && ids.find((candidate) => candidate.startsWith('details-'))) ||
        ids.find((candidate) => !candidate.startsWith('details-'))
      const action = id?.replace(/^details-/, '')
      switch (action) {
        case 'command-palette':
          if (palette.open) {
            setPalette((current) => ({ ...current, open: false }))
          } else {
            void openPalette('root')
          }
          return true
        case 'shortcuts':
          setHelpOpen(true)
          return true
        case 'search':
          if (page.current?.onSearch) {
            page.current.onSearch()
          } else {
            void openPalette('root')
          }
          return true
        case 'create':
          void openPalette('create')
          return true
        case 'go-my-work':
        case 'go-tasks':
        case 'go-board':
        case 'go-timeline':
        case 'go-workflows':
          navigate(hrefFor([PAGE_OF[action]]))
          return true
        case 'select-next':
          moveSelection(1)
          return true
        case 'select-previous':
          moveSelection(-1)
          return true
        case 'open':
          if (targetKey) {
            openTask(targetKey)
          }
          return Boolean(targetKey)
        case 'edit-summary':
          if (page.current?.onEditSummary) {
            page.current.onEditSummary()
          } else if (targetKey && targetKey === peekKey) {
            // The peek shows the task's details, which read this from the URL as its page does.
            const query = new URLSearchParams(location.query)
            query.set('edit', 'summary')
            navigate(hrefFor(location.segments, query), { replace: true })
          } else if (targetKey) {
            navigate(hrefFor(['task', targetKey], { edit: 'summary' }))
          }
          return Boolean(targetKey)
        case 'status':
        case 'assignee':
        case 'priority':
          if (targetKey) {
            void openPalette(VIEW_OF[action])
          }
          return Boolean(targetKey)
        case 'escape':
        case 'back':
          if (taskKey) {
            navigate(lastList.current)
            return true
          }
          if (peekKey) {
            closePeek()
            return true
          }
          if (selectedKey) {
            setSelectedKey(null)
            return true
          }
          return false
      }
      return false
    },
    [location, taskKey, peekKey, targetKey, selectedKey, palette.open, openPalette, moveSelection],
  )

  // Read by the one window listener, which is attached once.
  const runRef = useRef(run)
  runRef.current = run

  useEffect(() => {
    const mac = resolveShortcutPlatform() === 'mac'
    const matcher = createKeyMatcher(TASK_MANAGER_SHORTCUTS.flatMap((group) => group.shortcuts))
    const onKeyDown = (event: KeyboardEvent) => {
      const chord = chordOf(event, mac)
      // The palette's own list takes Ctrl+K as "move up" and marks it handled; it still closes the palette.
      if (event.isComposing || (event.defaultPrevented && chord !== 'mod+K')) {
        return
      }
      const target = event.target
      const onNothing = target === document.body || target === document.documentElement
      const inApp = onNothing || (target instanceof Node && rootRef.current?.contains(target) === true)
      const inDialog = target instanceof HTMLElement && target.closest('[role="dialog"]') !== null
      const allowed =
        chord === 'mod+K'
          ? // It types nothing, so it works from a field and from its own dialog too.
            inApp || inDialog
          : // Enter belongs to the control that has focus; the selection opens with it only when nothing has.
            inApp && !isTypingTarget(target) && (chord !== 'Enter' || onNothing)
      if (!allowed) {
        matcher.reset()
        return
      }
      const result = matcher.press(chord, event.timeStamp)
      if (result.kind === 'pending') {
        event.preventDefault()
      } else if (result.kind === 'match' && runRef.current(result.ids)) {
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const register = useCallback((next: PageShortcuts | null) => {
    page.current = next
  }, [])
  const context = useMemo<ShortcutsContextValue>(
    () => ({ register, selectedKey, select: setSelectedKey, move: moveSelection }),
    [register, selectedKey, moveSelection],
  )

  const currentTask = targetKey ? (tasks?.find((task) => task.key === targetKey) ?? null) : null
  const menu = currentTask ? menuFor(currentTask) : null

  return (
    <ShortcutsContext.Provider value={context}>
      <div ref={rootRef} className='contents'>
        {children}
      </div>
      <TaskCommandPalette
        open={palette.open}
        onOpenChange={(open) => {
          setPalette((current) => ({ ...current, open }))
          if (!open) {
            setPaletteQuery('')
          }
        }}
        defaultView={palette.view}
        tasks={tasks ?? []}
        searching={tasks === null}
        onQueryChange={setPaletteQuery}
        elsewhere={elsewhere.tasks}
        searchingElsewhere={elsewhere.searching}
        recentKeys={recentKeys}
        currentPage={taskKey ? undefined : currentPage}
        currentTask={currentTask}
        statuses={statuses}
        assignees={assignees.map((option) => ({ ...option.assignee }))}
        workflows={workflows}
        onOpenTask={(task) => openTaskIn(task.key, task.project)}
        onCreateTask={(summary) => void createTask(summary)}
        onNavigate={(target) => navigate(hrefFor([target]))}
        onChangeStatus={menu ? (status) => menu.onStatusChange?.(Number(status.id)) : undefined}
        onChangeAssignee={
          menu
            ? (assignee) =>
                menu.onAssigneeChange?.(assignee && { kind: assignee.kind, name: assignee.name, id: assignee.id })
            : undefined
        }
        onChangePriority={menu?.onPriorityChange}
        onStartWorkflow={
          currentTask
            ? (workflow) =>
                void workflowsApi(instanceId)
                  .workflow_start({ task: currentTask.key, workflow: workflow.id })
                  .then(() => toast.success(`Started ${workflow.name} on ${currentTask.key}`))
                  .catch(fail)
            : undefined
        }
      />
      <KeyboardShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </ShortcutsContext.Provider>
  )
}
