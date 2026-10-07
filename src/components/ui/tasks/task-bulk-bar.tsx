import { Check, ChevronDown, ChevronsUp, CircleDot, ListTree, Loader2, Milestone, Minus, Plus, RotateCcw, Tag, Trash2, TriangleAlert, UserRound, X } from 'lucide-react'
import { type ComponentType, type ReactNode, useEffect, useRef, useState } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../alert-dialog'
import { Button } from '../button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '../popover'
import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { cn } from '@/lib/utils'

import { MENU_SCROLL_POPUP, MenuScrollArea } from './item-menu'
import { TaskAssignee, type TaskAssigneeValue } from './task-assignee'
import { TaskLabelDot, useTaskLabelColor } from './task-label-chip'
import { TASK_PRIORITIES, TaskPriorityIcon, type TaskPriority } from './task-priority-icon'
import { TaskStatusBadge, type TaskStatusCategory } from './task-status-badge'
import { type TaskVersion, taskVersionOptions } from './task-version-chip'

export interface TaskBulkBarTask {
  key: string
  summary: string
}

export interface TaskBulkBarStatus {
  id?: string | number
  name: string
  category: TaskStatusCategory
  color?: string | null
}

export interface TaskBulkBarAssignee extends TaskAssigneeValue {
  id?: string
}

export type TaskBulkBarAction = 'status' | 'assignee' | 'priority' | 'labels' | 'version' | 'parent' | 'delete'

/** How a bulk action went: how many of how many, and why the rest did not. */
export interface TaskBulkBarResult {
  action: TaskBulkBarAction
  done: number
  total: number
  failures: { key: string; message: string }[]
}

export interface TaskBulkBarProps {
  /** The picked tasks. The bar shows while there is at least one, or a result. */
  selected: TaskBulkBarTask[]
  /** Clears the selection: the bar's close button, and Esc. */
  onClear: () => void
  statuses?: TaskBulkBarStatus[]
  onChangeStatus?: (status: TaskBulkBarStatus) => void
  assignees?: TaskBulkBarAssignee[]
  onChangeAssignee?: (assignee: TaskBulkBarAssignee | null) => void
  onChangePriority?: (priority: TaskPriority) => void
  /** The project's labels, offered to add. */
  labels?: string[]
  /** How many of the picked tasks carry each label, so the list shows all, some or none. */
  labelCounts?: Record<string, number>
  onAddLabel?: (label: string) => void
  onRemoveLabel?: (label: string) => void
  /** The project's versions; archived ones are not offered. */
  versions?: TaskVersion[]
  /** Puts every picked task in a version; null takes them out of theirs. */
  onSetVersion?: (id: string | null) => void
  /** Tasks that can become the parent. The picked ones are left out. */
  parents?: TaskBulkBarTask[]
  /** Sets the parent of every picked task; null takes them out of their parent. */
  onSetParent?: (key: string | null) => void
  /** Deletes the picked tasks, after the confirm. */
  onDelete?: () => void
  /** The action in flight: its control spins and the rest wait. */
  busy?: TaskBulkBarAction | null
  result?: TaskBulkBarResult | null
  /** Runs the last action again on the tasks it failed for. */
  onRetryFailed?: () => void
  onDismissResult?: () => void
  className?: string
}

const DONE_VERB: Record<TaskBulkBarAction, string> = {
  status: 'updated',
  assignee: 'updated',
  priority: 'updated',
  labels: 'updated',
  version: 'updated',
  parent: 'moved',
  delete: 'deleted',
}

const CONFIRM_LIST = 8
const FAILURE_LIST = 3

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** Esc inside a menu, a dialog or a field belongs to that; anywhere else it clears the selection. */
function escapeIsOurs(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) {
    return false
  }
  const target = event.target instanceof HTMLElement ? event.target : null
  if (!target) {
    return true
  }
  if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
    return false
  }
  return !target.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"], [data-slot="popover-content"]')
}

/** A label's colour from the TaskLabelColorsProvider above, as a dot; nothing without one. */
function LabelColor({ label }: { label: string }) {
  const color = useTaskLabelColor(label)
  return color ? <TaskLabelDot color={color} /> : null
}

/** A control's face: its icon (a spinner while it runs) and, when there is room, its name. */
function TriggerFace({ icon: Icon, label, busy }: { icon: ComponentType<{ className?: string }>; label: string; busy: boolean }) {
  return (
    <>
      {busy ? <Loader2 className='animate-spin' /> : <Icon />}
      <span className='hidden @xl:inline'>{label}</span>
      <ChevronDown className='hidden text-muted-foreground @xl:block' />
    </>
  )
}

function ResultStrip({
  result,
  onRetryFailed,
  onDismissResult,
}: {
  result: TaskBulkBarResult
  onRetryFailed?: () => void
  onDismissResult?: () => void
}) {
  const failed = result.failures.length
  const verb = DONE_VERB[result.action]
  const shown = result.failures.slice(0, FAILURE_LIST)
  return (
    <div
      role='status'
      className={cn(
        'flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-sm',
        failed > 0
          ? 'border-amber-500/30 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100'
          : 'border-emerald-500/30 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
      )}
    >
      {failed > 0 ? <TriangleAlert className='mt-0.5 size-4 shrink-0' /> : <Check className='mt-0.5 size-4 shrink-0' />}
      <div className='flex min-w-0 flex-1 flex-col gap-1'>
        <p className='font-medium'>
          {result.done} of {plural(result.total, 'task')} {verb}
          {failed > 0 ? `; ${failed} could not be` : ''}.
        </p>
        {failed > 0 ? (
          <ul className='flex min-w-0 flex-col gap-0.5 text-xs'>
            {shown.map((failure) => (
              <li key={failure.key} className='min-w-0 [overflow-wrap:anywhere]'>
                <span className='font-mono font-medium'>{failure.key}</span>: {failure.message}
              </li>
            ))}
            {failed > shown.length ? <li className='opacity-80'>and {failed - shown.length} more</li> : null}
          </ul>
        ) : null}
      </div>
      <div className='flex shrink-0 items-center gap-1'>
        {failed > 0 && onRetryFailed ? (
          <Button variant='outline' size='xs' className='bg-transparent' onClick={onRetryFailed}>
            <RotateCcw />
            Retry {failed}
          </Button>
        ) : null}
        {onDismissResult ? (
          <Button variant='ghost' size='icon-xs' aria-label='Dismiss' onClick={onDismissResult}>
            <X />
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The bar shown while tasks are picked. Each control applies to all of them;
 * the host runs the action task by task and reports back through `busy` and
 * `result`. The host places the bar, usually floating at the bottom of the
 * page, and keeps the selection.
 */
export function TaskBulkBar({
  selected,
  onClear,
  statuses,
  onChangeStatus,
  assignees,
  onChangeAssignee,
  onChangePriority,
  labels = [],
  labelCounts = {},
  onAddLabel,
  onRemoveLabel,
  versions,
  onSetVersion,
  parents,
  onSetParent,
  onDelete,
  busy = null,
  result = null,
  onRetryFailed,
  onDismissResult,
  className,
}: TaskBulkBarProps) {
  const count = selected.length
  const waiting = busy !== null
  const [labelsOpen, setLabelsOpen] = useState(false)
  const [labelQuery, setLabelQuery] = useState('')
  const [parentOpen, setParentOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const clear = useRef(onClear)
  clear.current = onClear

  useEffect(() => {
    if (count === 0) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (escapeIsOurs(event)) {
        clear.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [count])

  if (count === 0 && !result) {
    return null
  }

  const pickedKeys = new Set(selected.map((task) => task.key))
  const parentChoices = (parents ?? []).filter((task) => !pickedKeys.has(task.key))
  const typedLabel = labelQuery.trim()
  const canCreateLabel = Boolean(onAddLabel && typedLabel && !labels.some((label) => label.toLowerCase() === typedLabel.toLowerCase()))
  const shownConfirm = selected.slice(0, CONFIRM_LIST)

  const pickLabel = (label: string) => {
    const has = labelCounts[label] ?? 0
    if (has >= count && onRemoveLabel) {
      onRemoveLabel(label)
    } else {
      onAddLabel?.(label)
    }
    setLabelsOpen(false)
    setLabelQuery('')
  }

  let controls: ReactNode = null
  if (count > 0) {
    controls = (
      <div
        role='toolbar'
        aria-label={`Bulk actions for ${plural(count, 'task')}`}
        className='flex h-12 min-w-0 items-center gap-1 rounded-xl border bg-popover px-1.5 text-popover-foreground shadow-lg'
      >
        <Button variant='ghost' size='icon-sm' aria-label='Clear the selection' title='Clear the selection (Esc)' onClick={onClear}>
          <X />
        </Button>
        <span className='shrink-0 px-1 text-sm font-medium whitespace-nowrap tabular-nums' aria-live='polite'>
          {waiting ? `Updating ${count}…` : `${count} selected`}
        </span>
        <div aria-hidden='true' className='mx-1 h-5 w-px shrink-0 bg-border' />
        <ScrollArea scrollbars='horizontal' className='min-w-0 flex-1' innerClassName='flex-row items-center gap-0.5'>
          {onChangeStatus && statuses?.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant='ghost' size='sm' disabled={waiting} aria-label='Status' className='shrink-0 px-2' />}>
                <TriggerFace icon={CircleDot} label='Status' busy={busy === 'status'} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align='start' className={MENU_SCROLL_POPUP}>
                <MenuScrollArea>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Set the status of {plural(count, 'task')}</DropdownMenuLabel>
                    {statuses.map((status) => (
                      <DropdownMenuItem key={status.id ?? status.name} onClick={() => onChangeStatus(status)}>
                        <TaskStatusBadge name={status.name} category={status.category} color={status.color} size='sm' />
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </MenuScrollArea>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {onChangeAssignee && assignees ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant='ghost' size='sm' disabled={waiting} aria-label='Assignee' className='shrink-0 px-2' />}>
                <TriggerFace icon={UserRound} label='Assignee' busy={busy === 'assignee'} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align='start' className={MENU_SCROLL_POPUP}>
                <MenuScrollArea>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Assign {plural(count, 'task')} to</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => onChangeAssignee(null)}>
                      <TaskAssignee assignee={null} size='sm' />
                      <span className='text-muted-foreground'>Unassigned</span>
                    </DropdownMenuItem>
                    {assignees.map((assignee) => (
                      <DropdownMenuItem key={assignee.id ?? `${assignee.kind}:${assignee.name}`} onClick={() => onChangeAssignee(assignee)}>
                        <TaskAssignee assignee={assignee} size='sm' />
                        <span className='min-w-0 truncate'>{assignee.name}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </MenuScrollArea>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {onChangePriority ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant='ghost' size='sm' disabled={waiting} aria-label='Priority' className='shrink-0 px-2' />}>
                <TriggerFace icon={ChevronsUp} label='Priority' busy={busy === 'priority'} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align='start' className={MENU_SCROLL_POPUP}>
                <MenuScrollArea>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Set the priority of {plural(count, 'task')}</DropdownMenuLabel>
                    {TASK_PRIORITIES.map((priority) => (
                      <DropdownMenuItem key={priority} onClick={() => onChangePriority(priority)}>
                        <TaskPriorityIcon priority={priority} withLabel />
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </MenuScrollArea>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {onSetVersion && versions ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant='ghost' size='sm' disabled={waiting} aria-label='Version' className='shrink-0 px-2' />}>
                <TriggerFace icon={Milestone} label='Version' busy={busy === 'version'} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align='start' className={cn('max-h-80 min-w-52', MENU_SCROLL_POPUP)}>
                <MenuScrollArea>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Put {plural(count, 'task')} in</DropdownMenuLabel>
                    {taskVersionOptions(versions).map((option) => (
                      <DropdownMenuItem key={option.value || 'none'} aria-label={option.text} onClick={() => onSetVersion(option.value || null)}>
                        <span className='flex min-w-0 flex-1 items-center'>{option.display}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </MenuScrollArea>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {onAddLabel || onRemoveLabel ? (
            <Popover
              open={labelsOpen}
              onOpenChange={(open) => {
                setLabelsOpen(open)
                if (!open) {
                  setLabelQuery('')
                }
              }}
            >
              <PopoverTrigger render={<Button variant='ghost' size='sm' disabled={waiting} aria-label='Labels' className='shrink-0 px-2' />}>
                <TriggerFace icon={Tag} label='Labels' busy={busy === 'labels'} />
              </PopoverTrigger>
              <PopoverContent align='start' className='w-64 gap-0 p-0'>
                <Command>
                  <CommandInput value={labelQuery} onValueChange={setLabelQuery} placeholder='Find or add a label…' />
                  <ScrollArea className='max-h-72' viewportClassName='scroll-py-1'>
                    <CommandList className='max-h-none overflow-visible'>
                      <CommandEmpty>No labels yet.</CommandEmpty>
                      <CommandGroup heading={`On ${plural(count, 'task')}`}>
                        {labels.map((label) => {
                          const has = labelCounts[label] ?? 0
                          const all = has >= count
                          return (
                            <CommandItem key={label} value={label} onSelect={() => pickLabel(label)}>
                              <span className='flex size-4 shrink-0 items-center justify-center rounded-sm border'>
                                {all ? <Check className='size-3' /> : has > 0 ? <Minus className='size-3' /> : null}
                              </span>
                              <LabelColor label={label} />
                              <span className='min-w-0 flex-1 truncate'>{label}</span>
                              <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>
                                {all && onRemoveLabel ? 'Remove' : has > 0 ? `${has}/${count}` : ''}
                              </span>
                            </CommandItem>
                          )
                        })}
                        {canCreateLabel ? (
                          <CommandItem value={`add ${typedLabel}`} forceMount onSelect={() => pickLabel(typedLabel)}>
                            <Plus className='text-muted-foreground' />
                            <span className='min-w-0 flex-1 truncate'>Add “{typedLabel}”</span>
                          </CommandItem>
                        ) : null}
                      </CommandGroup>
                    </CommandList>
                  </ScrollArea>
                </Command>
              </PopoverContent>
            </Popover>
          ) : null}

          {onSetParent ? (
            <Popover open={parentOpen} onOpenChange={setParentOpen}>
              <PopoverTrigger render={<Button variant='ghost' size='sm' disabled={waiting} aria-label='Parent' className='shrink-0 px-2' />}>
                <TriggerFace icon={ListTree} label='Parent' busy={busy === 'parent'} />
              </PopoverTrigger>
              <PopoverContent align='start' className='w-72 gap-0 p-0'>
                <Command>
                  <CommandInput placeholder='Find a parent task…' />
                  <ScrollArea className='max-h-72' viewportClassName='scroll-py-1'>
                    <CommandList className='max-h-none overflow-visible'>
                      <CommandEmpty>No task matches.</CommandEmpty>
                      <CommandGroup heading={`Move ${plural(count, 'task')} under`}>
                        <CommandItem
                          value='no parent'
                          onSelect={() => {
                            onSetParent(null)
                            setParentOpen(false)
                          }}
                        >
                          <span className='text-muted-foreground'>No parent</span>
                        </CommandItem>
                        {parentChoices.map((task) => (
                          <CommandItem
                            key={task.key}
                            value={`${task.key} ${task.summary}`}
                            onSelect={() => {
                              onSetParent(task.key)
                              setParentOpen(false)
                            }}
                          >
                            <span className='shrink-0 font-mono text-xs text-muted-foreground'>{task.key}</span>
                            <span className='min-w-0 flex-1 truncate'>{task.summary}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </ScrollArea>
                </Command>
              </PopoverContent>
            </Popover>
          ) : null}
        </ScrollArea>

        {onDelete ? (
          <>
            <Button
              variant='ghost'
              size='sm'
              disabled={waiting}
              aria-label='Delete'
              className='shrink-0 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive'
              onClick={() => setConfirmOpen(true)}
            >
              {busy === 'delete' ? <Loader2 className='animate-spin' /> : <Trash2 />}
              <span className='hidden @xl:inline'>Delete</span>
            </Button>
            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {plural(count, 'task')}?</AlertDialogTitle>
                  <AlertDialogDescription>These go, and it cannot be undone:</AlertDialogDescription>
                </AlertDialogHeader>
                <ScrollArea className='-mt-3 max-h-56'>
                  <ul className='flex min-w-0 flex-col gap-1 text-sm'>
                    {shownConfirm.map((task) => (
                      <li key={task.key} className='flex min-w-0 items-baseline gap-2'>
                        <span className='shrink-0 font-mono text-xs text-muted-foreground'>{task.key}</span>
                        <span className='min-w-0 truncate'>{task.summary}</span>
                      </li>
                    ))}
                    {count > shownConfirm.length ? (
                      <li className='text-muted-foreground'>and {plural(count - shownConfirm.length, 'more task')}</li>
                    ) : null}
                  </ul>
                </ScrollArea>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant='destructive'
                    onClick={() => {
                      setConfirmOpen(false)
                      onDelete()
                    }}
                  >
                    Delete {plural(count, 'task')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : null}
      </div>
    )
  }

  return (
    <div data-slot='task-bulk-bar' className={cn('@container flex w-full min-w-0 flex-col gap-2', className)}>
      {result ? <ResultStrip result={result} onRetryFailed={onRetryFailed} onDismissResult={onDismissResult} /> : null}
      {controls}
    </div>
  )
}
