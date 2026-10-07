import { useId } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../dialog'
import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { cn } from '@/lib/utils'

/** `mac` shows ⌘ ⌥ ⇧; `other` shows Ctrl Alt Shift. */
export type ShortcutPlatform = 'mac' | 'other'

export interface KeyboardShortcut {
  id: string
  /**
   * The keys in order: each inner list is one chord pressed together, and a
   * second list follows the first (`[['G'], ['T']]` is G then T). `mod` is ⌘
   * on a Mac and Ctrl elsewhere.
   */
  keys: string[][]
  label: string
}

export interface KeyboardShortcutGroup {
  id: string
  title: string
  description?: string
  shortcuts: KeyboardShortcut[]
}

/** The task manager's shortcut set, grouped by where each one works. */
export const TASK_MANAGER_SHORTCUTS: KeyboardShortcutGroup[] = [
  {
    id: 'everywhere',
    title: 'Everywhere',
    shortcuts: [
      { id: 'command-palette', keys: [['mod', 'K']], label: 'Open the command palette' },
      { id: 'shortcuts', keys: [['?']], label: 'Show keyboard shortcuts' },
      { id: 'search', keys: [['/']], label: 'Search or filter this page' },
      { id: 'create', keys: [['C']], label: 'Create a task on this page' },
      { id: 'escape', keys: [['Esc']], label: 'Close, or go back' },
    ],
  },
  {
    id: 'go-to',
    title: 'Go to',
    shortcuts: [
      { id: 'go-my-work', keys: [['G'], ['M']], label: 'My work' },
      { id: 'go-tasks', keys: [['G'], ['T']], label: 'Tasks' },
      { id: 'go-board', keys: [['G'], ['B']], label: 'Board' },
      { id: 'go-timeline', keys: [['G'], ['L']], label: 'Timeline' },
      { id: 'go-workflows', keys: [['G'], ['W']], label: 'Workflows' },
    ],
  },
  {
    id: 'lists',
    title: 'Tasks, Board and Timeline',
    description: 'On the selected task',
    shortcuts: [
      { id: 'select-next', keys: [['J']], label: 'Select the next task' },
      { id: 'select-previous', keys: [['K']], label: 'Select the previous task' },
      { id: 'open', keys: [['Enter']], label: 'Open it' },
      { id: 'edit-summary', keys: [['E']], label: 'Edit its summary' },
      { id: 'status', keys: [['S']], label: 'Change its status' },
      { id: 'assignee', keys: [['A']], label: 'Change its assignee' },
      { id: 'priority', keys: [['P']], label: 'Change its priority' },
      // The browser's own context-menu keys; listed, never matched (a chord leaves Shift out).
      { id: 'context-menu', keys: [['shift', 'F10']], label: 'Open its menu (or the Menu key)' },
    ],
  },
  {
    id: 'details',
    title: 'Task details',
    shortcuts: [
      { id: 'details-edit-summary', keys: [['E']], label: 'Edit the summary' },
      { id: 'details-status', keys: [['S']], label: 'Change the status' },
      { id: 'details-assignee', keys: [['A']], label: 'Change the assignee' },
      { id: 'details-priority', keys: [['P']], label: 'Change the priority' },
      { id: 'details-back', keys: [['Esc']], label: 'Back to the list' },
    ],
  },
]

/** A shortcut from the set by id, for showing its keys as a hint elsewhere. */
export function findShortcut(
  id: string,
  groups: KeyboardShortcutGroup[] = TASK_MANAGER_SHORTCUTS,
): KeyboardShortcut | undefined {
  for (const group of groups) {
    const found = group.shortcuts.find((shortcut) => shortcut.id === id)
    if (found) return found
  }
  return undefined
}

/** The platform given, or the one this browser runs on. */
export function resolveShortcutPlatform(platform?: ShortcutPlatform): ShortcutPlatform {
  if (platform) return platform
  if (typeof navigator === 'undefined') return 'other'
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const name = nav.userAgentData?.platform || nav.platform || nav.userAgent
  return /mac|iphone|ipad|ipod/i.test(name) ? 'mac' : 'other'
}

const MAC_KEYS: Record<string, string> = { mod: '⌘', alt: '⌥', shift: '⇧', ctrl: '⌃' }
const OTHER_KEYS: Record<string, string> = { mod: 'Ctrl', alt: 'Alt', shift: 'Shift', ctrl: 'Ctrl' }
const SPOKEN: Record<string, string> = { mod: 'Command', alt: 'Option', shift: 'Shift', ctrl: 'Control' }

export interface ShortcutKeysProps {
  keys: string[][]
  platform?: ShortcutPlatform
  className?: string
}

/** Key caps for one shortcut: chords side by side, "then" between steps. */
export function ShortcutKeys({ keys, platform, className }: ShortcutKeysProps) {
  const mac = resolveShortcutPlatform(platform) === 'mac'
  const names = mac ? MAC_KEYS : OTHER_KEYS
  const spoken = keys
    .map((step) =>
      step.map((key) => (mac ? SPOKEN[key] : OTHER_KEYS[key]) ?? key).join(' '),
    )
    .join(' then ')
  return (
    <span
      role='img'
      aria-label={spoken}
      className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap', className)}
    >
      {keys.map((step, index) => (
        <span key={step.join('+')} aria-hidden='true' className='inline-flex items-center gap-1'>
          {index > 0 && <span className='text-[11px] text-muted-foreground'>then</span>}
          {step.map((key) => (
            <kbd
              key={key}
              className='inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-sans text-[11px] font-medium leading-none text-muted-foreground'
            >
              {names[key] ?? key}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  )
}

export interface KeyboardShortcutsListProps {
  groups?: KeyboardShortcutGroup[]
  platform?: ShortcutPlatform
  className?: string
}

/** The shortcut groups as labelled lists; two columns when there is room. */
export function KeyboardShortcutsList({
  groups = TASK_MANAGER_SHORTCUTS,
  platform,
  className,
}: KeyboardShortcutsListProps) {
  const baseId = useId()
  return (
    <div className={cn('@container', className)}>
      <div className='grid gap-x-8 gap-y-5 @xl:grid-cols-2'>
        {groups.map((group) => {
          const headingId = `${baseId}-${group.id}`
          return (
            <section key={group.id} aria-labelledby={headingId} className='min-w-0'>
              <h3 id={headingId} className='text-xs font-medium text-muted-foreground'>
                {group.title}
                {group.description && (
                  <span className='font-normal'> · {group.description}</span>
                )}
              </h3>
              <ul className='mt-1 divide-y divide-border/60'>
                {group.shortcuts.map((shortcut) => (
                  <li key={shortcut.id} className='flex min-w-0 items-center justify-between gap-3 py-1.5'>
                    <span className='min-w-0 text-sm [overflow-wrap:anywhere]'>{shortcut.label}</span>
                    <ShortcutKeys keys={shortcut.keys} platform={platform} />
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}

export interface KeyboardShortcutsDialogProps extends KeyboardShortcutsListProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
  groups,
  platform,
  className,
}: KeyboardShortcutsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogContent className='max-h-[85vh] grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden sm:max-w-3xl'>
        <DialogHeader className='pr-8'>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            None of them fire while you are typing in a field.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className='-mx-6' innerClassName='px-6'>
          <KeyboardShortcutsList groups={groups} platform={platform} className={className} />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
