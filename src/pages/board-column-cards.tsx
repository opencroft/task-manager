// The cards of one board column. A column of hundreds renders a batch at a
// time, adding the next as its end scrolls near. The list and each card are
// memoised, so a drag re-renders only the columns whose drop marker, dragged
// card or selection changed, and within them only the cards that changed.

import { type PointerEvent as ReactPointerEvent, type ReactNode, memo, useEffect, useRef, useState } from 'react'

import { BoardCard } from '@/components/ui/tasks/board-card'
import { BoardDropIndicator } from '@/components/ui/tasks/board-drop-indicator'
import { TaskActionsMenu, TaskContextMenu, taskFieldEntries } from '@/components/ui/tasks/task-menu'

import type { TaskSummary } from '../../shared/types'
import type { ProjectContextValue } from '../app/project'
import { openTask } from '../app/task-opener'

/** Cards a column renders at first, and how many more each time its end comes near. */
const CARD_BATCH = 10

export interface BoardColumnCardsProps {
  cards: TaskSummary[]
  /** At phone width a long press lifts a card, so cards carry no context menu. */
  phone: boolean
  /** The selected card, when it is in this column. */
  selectedKey: string | null
  /** The card being dragged, when it is in this column. */
  draggedKey: string | null
  /** Where a drag would land in this column: before that card, `null` at the end; undefined when it is not over this column. */
  dropBeforeKey: string | null | undefined
  steps: Map<string, string>
  menuFor: ProjectContextValue['menuFor']
  onDragStart: (task: TaskSummary, event: ReactPointerEvent<HTMLElement>) => void
  /** The picked cards in this column, for bulk actions. */
  picked: ReadonlySet<string>
  /** Ctrl/Cmd-click toggles a card; Shift-click (`range`) takes the cards from the last one picked. */
  onPickToggle: (task: TaskSummary, range: boolean) => void
}

/** A card reads only which blockers are still open, not the full blocker list. */
export function withOpenBlockers(task: TaskSummary): TaskSummary & { openBlockers: string[] } {
  return { ...task, openBlockers: task.blockers.filter((b) => b.open).map((b) => b.key) }
}

/** The nearest element that scrolls the sentinel: the column's own list, or the board around it. */
function scrollRoot(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(node).overflowY)) {
      return node
    }
  }
  return null
}

interface BoardColumnCardProps {
  task: TaskSummary
  phone: boolean
  selected: boolean
  dragged: boolean
  workflowStep: string | null
  menuFor: ProjectContextValue['menuFor']
  onDragStart: BoardColumnCardsProps['onDragStart']
  checked: boolean
  onPickToggle: BoardColumnCardsProps['onPickToggle']
}

/** One card. Memoised, so a drop or a batch coming into view renders only the cards that changed or are new. */
const BoardColumnCard = memo(function BoardColumnCard({
  task,
  phone,
  selected,
  dragged,
  workflowStep,
  menuFor,
  onDragStart,
  checked,
  onPickToggle,
}: BoardColumnCardProps) {
  const menu = menuFor(task)
  const card = (
    <BoardCard
      data-task-key={task.key}
      task={withOpenBlockers(task)}
      selected={selected}
      checked={checked}
      onSelectToggle={(range) => onPickToggle(task, range)}
      workflowStep={workflowStep}
      dragState={dragged ? 'source' : 'idle'}
      onOpen={() => openTask(task.key)}
      onPointerDown={(event) => onDragStart(task, event)}
      actions={<TaskActionsMenu {...menu} label={`Actions for ${task.key}`} />}
      // A chip's own values change it in place; on a phone a long press lifts the card instead.
      chipMenu={phone ? undefined : (chip) => taskFieldEntries(menu, chip)}
    />
  )
  // On a phone a long press lifts the card, so it does not also open a menu; the "…" button keeps the actions.
  return phone ? (
    <div data-board-key={task.key}>{card}</div>
  ) : (
    <TaskContextMenu {...menu} render={<div data-board-key={task.key} />}>
      {card}
    </TaskContextMenu>
  )
})

export const BoardColumnCards = memo(function BoardColumnCards({
  cards,
  phone,
  selectedKey,
  draggedKey,
  dropBeforeKey,
  steps,
  menuFor,
  onDragStart,
  picked,
  onPickToggle,
}: BoardColumnCardsProps) {
  const [batch, setBatch] = useState(CARD_BATCH)
  const sentinel = useRef<HTMLDivElement>(null)
  // A card that is selected or dropped next to is always rendered, wherever it sits.
  const needed = Math.max(
    selectedKey ? cards.findIndex((task) => task.key === selectedKey) + 1 : 0,
    dropBeforeKey ? cards.findIndex((task) => task.key === dropBeforeKey) + 1 : 0,
  )
  const shown = Math.max(batch, needed)

  useEffect(() => {
    const element = sentinel.current
    if (!element) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setBatch((current) => current + CARD_BATCH)
        }
      },
      { root: scrollRoot(element), rootMargin: '600px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [shown, cards.length])

  const children: ReactNode[] = []
  for (const task of cards.slice(0, shown)) {
    if (dropBeforeKey === task.key) {
      children.push(<BoardDropIndicator key="drop" />)
    }
    children.push(
      <BoardColumnCard
        key={task.key}
        task={task}
        phone={phone}
        selected={task.key === selectedKey}
        dragged={task.key === draggedKey}
        workflowStep={steps.get(task.key) ?? null}
        menuFor={menuFor}
        onDragStart={onDragStart}
        checked={picked.has(task.key)}
        onPickToggle={onPickToggle}
      />,
    )
  }
  if (shown < cards.length) {
    children.push(<div key="more" ref={sentinel} aria-hidden className="h-px shrink-0" />)
  }
  if (dropBeforeKey === null && cards.some((task) => task.key !== draggedKey)) {
    children.push(<BoardDropIndicator key="drop" variant="slot" />)
  }
  return children
})
