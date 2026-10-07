import { ArrowRightFromLine, CalendarClock, CalendarMinus, CalendarPlus, Check, Copy, ExternalLink, Link2, ListPlus, MoreHorizontal, Trash2 } from 'lucide-react'
import type { ComponentType, ReactElement, ReactNode } from 'react'

import { Button } from '../button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../dropdown-menu'
import { cn } from '@/lib/utils'

import { type ItemMenuEntries, MENU_SCROLL_POPUP, MenuScrollArea } from './item-menu'
import { TaskAssignee } from './task-assignee'
import { TASK_PRIORITIES, TASK_PRIORITY_LABELS, type TaskPriority, TaskPriorityIcon } from './task-priority-icon'
import { TaskStatusBadge, type TaskStatusCategory } from './task-status-badge'

export interface TaskMenuStatus {
  id: number
  name: string
  category: TaskStatusCategory
  color?: string | null
}

export interface TaskMenuAssignee {
  kind: 'agent' | 'person'
  name: string
  /** For agents: the id the host assigns by. */
  id?: string
}

/**
 * What a task's menu offers. Every entry is optional: an entry appears only
 * when its callback is given, so each surface offers exactly what it supports.
 */
export interface TaskMenuProps {
  /** Current values, marked with a check in their submenus. */
  statusId?: number
  priority?: TaskPriority
  assigneeName?: string | null
  statuses?: TaskMenuStatus[]
  assignees?: TaskMenuAssignee[]
  onOpen?: () => void
  onCopyKey?: () => void
  onCopyLink?: () => void
  onStatusChange?: (statusId: number) => void
  onPriorityChange?: (priority: TaskPriority) => void
  onAssigneeChange?: (assignee: TaskMenuAssignee | null) => void
  onAddSubtask?: () => void
  /** Give the task dates (on a surface that plans them, like a timeline). */
  onSchedule?: () => void
  /** Clear the task's dates. */
  onUnschedule?: () => void
  /** Shift the task's dates by whole days, keeping its length (a Move submenu: a day or a week either way). */
  onMoveBy?: (days: number) => void
  /** Pick a task this one blocks (a dependency). */
  onBlocks?: () => void
  /** Start the task the day after its last blocker ends, keeping its length. Give it only when the task starts too early. */
  onMoveAfterBlockers?: () => void
  onDelete?: () => void
}

interface Parts {
  Item: ComponentType<{ onClick?: () => void; variant?: 'default' | 'destructive'; children: ReactNode; className?: string }>
  Separator: ComponentType
  Sub: ComponentType<{ children: ReactNode }>
  SubTrigger: ComponentType<{ children: ReactNode }>
  SubContent: ComponentType<{ children: ReactNode; className?: string }>
}

/** A submenu popup whose values scroll in the kit's ScrollArea. */
function scrolling(SubContent: Parts['SubContent']): Parts['SubContent'] {
  return function ScrollingSubContent({ children, className }) {
    return (
      <SubContent className={cn(className, MENU_SCROLL_POPUP)}>
        <MenuScrollArea>{children}</MenuScrollArea>
      </SubContent>
    )
  }
}

const CONTEXT: Parts = {
  Item: ContextMenuItem as Parts['Item'],
  Separator: ContextMenuSeparator as Parts['Separator'],
  Sub: ContextMenuSub as Parts['Sub'],
  SubTrigger: ContextMenuSubTrigger as Parts['SubTrigger'],
  SubContent: scrolling(ContextMenuSubContent as Parts['SubContent']),
}

const DROPDOWN: Parts = {
  Item: DropdownMenuItem as Parts['Item'],
  Separator: DropdownMenuSeparator as Parts['Separator'],
  Sub: DropdownMenuSub as Parts['Sub'],
  SubTrigger: DropdownMenuSubTrigger as Parts['SubTrigger'],
  SubContent: scrolling(DropdownMenuSubContent as Parts['SubContent']),
}

const MOVES = [
  { days: -7, label: 'A week earlier' },
  { days: -1, label: 'A day earlier' },
  { days: 1, label: 'A day later' },
  { days: 7, label: 'A week later' },
]

function Mark({ on }: { on: boolean }) {
  return <Check className={cn('ml-auto size-4', on ? 'opacity-100' : 'opacity-0')} />
}

function TaskMenuItems({ parts: P, ...menu }: TaskMenuProps & { parts: Parts }) {
  const groups: ReactNode[][] = [[], [], [], []]
  if (menu.onOpen) {
    groups[0].push(
      <P.Item key="open" onClick={menu.onOpen}>
        <ExternalLink />
        Open
      </P.Item>,
    )
  }
  if (menu.onCopyKey) {
    groups[0].push(
      <P.Item key="copy-key" onClick={menu.onCopyKey}>
        <Copy />
        Copy key
      </P.Item>,
    )
  }
  if (menu.onCopyLink) {
    groups[0].push(
      <P.Item key="copy-link" onClick={menu.onCopyLink}>
        <Link2 />
        Copy link
      </P.Item>,
    )
  }
  if (menu.onStatusChange && menu.statuses?.length) {
    const onStatusChange = menu.onStatusChange
    groups[1].push(
      <P.Sub key="status">
        <P.SubTrigger>Status</P.SubTrigger>
        <P.SubContent className="min-w-44">
          {menu.statuses.map((status) => (
            <P.Item key={status.id} onClick={() => onStatusChange(status.id)}>
              <TaskStatusBadge name={status.name} category={status.category} color={status.color} size="sm" />
              <Mark on={status.id === menu.statusId} />
            </P.Item>
          ))}
        </P.SubContent>
      </P.Sub>,
    )
  }
  if (menu.onAssigneeChange && menu.assignees) {
    const onAssigneeChange = menu.onAssigneeChange
    groups[1].push(
      <P.Sub key="assignee">
        <P.SubTrigger>Assignee</P.SubTrigger>
        <P.SubContent className="max-h-72 min-w-48">
          <P.Item onClick={() => onAssigneeChange(null)}>
            <TaskAssignee assignee={null} withName size="sm" />
            <Mark on={!menu.assigneeName} />
          </P.Item>
          {menu.assignees.map((assignee) => (
            <P.Item key={`${assignee.kind}:${assignee.id ?? assignee.name}`} onClick={() => onAssigneeChange(assignee)}>
              <TaskAssignee assignee={assignee} withName size="sm" />
              <Mark on={assignee.name === menu.assigneeName} />
            </P.Item>
          ))}
        </P.SubContent>
      </P.Sub>,
    )
  }
  if (menu.onPriorityChange) {
    const onPriorityChange = menu.onPriorityChange
    groups[1].push(
      <P.Sub key="priority">
        <P.SubTrigger>Priority</P.SubTrigger>
        <P.SubContent className="min-w-40">
          {TASK_PRIORITIES.map((priority) => (
            <P.Item key={priority} onClick={() => onPriorityChange(priority)}>
              <TaskPriorityIcon priority={priority} withLabel />
              <Mark on={priority === menu.priority} />
            </P.Item>
          ))}
        </P.SubContent>
      </P.Sub>,
    )
  }
  if (menu.onAddSubtask) {
    groups[2].push(
      <P.Item key="subtask" onClick={menu.onAddSubtask}>
        <ListPlus />
        Add subtask
      </P.Item>,
    )
  }
  if (menu.onSchedule) {
    groups[2].push(
      <P.Item key="schedule" onClick={menu.onSchedule}>
        <CalendarPlus />
        Schedule
      </P.Item>,
    )
  }
  if (menu.onMoveBy) {
    const onMoveBy = menu.onMoveBy
    groups[2].push(
      <P.Sub key="move">
        <P.SubTrigger>Move</P.SubTrigger>
        <P.SubContent className="min-w-40">
          {MOVES.map((move) => (
            <P.Item key={move.days} onClick={() => onMoveBy(move.days)}>
              {move.label}
            </P.Item>
          ))}
        </P.SubContent>
      </P.Sub>,
    )
  }
  if (menu.onUnschedule) {
    groups[2].push(
      <P.Item key="unschedule" onClick={menu.onUnschedule}>
        <CalendarMinus />
        Unschedule
      </P.Item>,
    )
  }
  if (menu.onMoveAfterBlockers) {
    groups[2].push(
      <P.Item key="move-after-blockers" onClick={menu.onMoveAfterBlockers}>
        <CalendarClock />
        Move after blockers
      </P.Item>,
    )
  }
  if (menu.onBlocks) {
    groups[2].push(
      <P.Item key="blocks" onClick={menu.onBlocks}>
        <ArrowRightFromLine />
        Blocks…
      </P.Item>,
    )
  }
  if (menu.onDelete) {
    groups[3].push(
      <P.Item key="delete" variant="destructive" onClick={menu.onDelete}>
        <Trash2 />
        Delete…
      </P.Item>,
    )
  }
  const filled = groups.filter((group) => group.length > 0)
  return (
    <>
      {filled.map((group, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: groups are positional
        <span key={index} className="contents">
          {index > 0 ? <P.Separator /> : null}
          {group}
        </span>
      ))}
    </>
  )
}

/**
 * One field's values from a task's menu, as flat `item-menu` entries with the
 * current one checked: the menu of a status badge, an assignee chip or a
 * priority, which changes that field in place. Empty without its callback.
 */
export function taskFieldEntries(menu: TaskMenuProps, field: 'status' | 'assignee' | 'priority'): ItemMenuEntries {
  if (field === 'status') {
    const { onStatusChange } = menu
    return onStatusChange
      ? (menu.statuses ?? []).map((status) => ({
          id: `status-${status.id}`,
          label: <TaskStatusBadge name={status.name} category={status.category} color={status.color} size="sm" />,
          checked: status.id === menu.statusId,
          group: 'change' as const,
          onSelect: () => onStatusChange(status.id),
        }))
      : []
  }
  if (field === 'assignee') {
    const { onAssigneeChange } = menu
    return onAssigneeChange && menu.assignees
      ? [
          { id: 'assignee-none', label: <TaskAssignee assignee={null} withName size="sm" />, checked: !menu.assigneeName, group: 'change' as const, onSelect: () => onAssigneeChange(null) },
          ...menu.assignees.map((assignee) => ({
            id: `assignee-${assignee.kind}:${assignee.id ?? assignee.name}`,
            label: <TaskAssignee assignee={assignee} withName size="sm" />,
            checked: assignee.name === menu.assigneeName,
            group: 'change' as const,
            onSelect: () => onAssigneeChange(assignee),
          })),
        ]
      : []
  }
  const { onPriorityChange } = menu
  return onPriorityChange
    ? TASK_PRIORITIES.map((priority) => ({
        id: `priority-${priority}`,
        label: <TaskPriorityIcon priority={priority} withLabel />,
        checked: priority === menu.priority,
        group: 'change' as const,
        onSelect: () => onPriorityChange(priority),
      }))
    : []
}

export interface TaskContextMenuProps extends TaskMenuProps {
  /** The element the menu opens on (a table row, a card); defaults to a div. */
  render?: ReactElement
  children: ReactNode
  className?: string
}

/**
 * A task's menu on right-click (long press on touch), around the element that
 * represents the task. The same entries as the task's "…" button, so every
 * action reachable by right-click is reachable without one too.
 */
export function TaskContextMenu({ render, children, className, ...menu }: TaskContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={render} className={className}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className={cn('min-w-48', MENU_SCROLL_POPUP)}>
        <MenuScrollArea>
          <TaskMenuItems parts={CONTEXT} {...menu} />
        </MenuScrollArea>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export interface TaskActionsMenuProps extends TaskMenuProps {
  /** Accessible name of the trigger button. */
  label?: string
  className?: string
}

/** A task's menu behind a "…" button — the pressable twin of the context menu. */
export function TaskActionsMenu({ label = 'Task actions', className, ...menu }: TaskActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={label} className={className} />}
        onClick={(event) => event.stopPropagation()}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={cn('w-auto min-w-48', MENU_SCROLL_POPUP)}>
        <MenuScrollArea>
          <TaskMenuItems parts={DROPDOWN} {...menu} />
        </MenuScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
