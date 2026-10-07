import { createContext, type ComponentProps, type ReactNode, useContext } from 'react'

import { cn } from '@/lib/utils'

/** A label's colour: a named palette entry, so every chip stays readable in light and dark. */
export type TaskLabelColor = 'gray' | 'red' | 'orange' | 'amber' | 'green' | 'teal' | 'sky' | 'blue' | 'violet' | 'pink'

/** The palette in picker order. */
export const TASK_LABEL_COLORS: readonly TaskLabelColor[] = ['gray', 'red', 'orange', 'amber', 'green', 'teal', 'sky', 'blue', 'violet', 'pink']

/** Each colour's name as a person reads it, for a picker and its accessible names. */
export const TASK_LABEL_COLOR_NAMES: Record<TaskLabelColor, string> = {
  gray: 'Gray',
  red: 'Red',
  orange: 'Orange',
  amber: 'Amber',
  green: 'Green',
  teal: 'Teal',
  sky: 'Sky',
  blue: 'Blue',
  violet: 'Violet',
  pink: 'Pink',
}

// Written out in full, so the host's Tailwind build finds every class.
const DOT: Record<TaskLabelColor, string> = {
  gray: 'bg-zinc-400 dark:bg-zinc-500',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  green: 'bg-green-500',
  teal: 'bg-teal-500',
  sky: 'bg-sky-500',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  pink: 'bg-pink-500',
}

const TaskLabelColorsContext = createContext<Readonly<Record<string, TaskLabelColor>> | null>(null)

/** The project's label colours by name, for every chip below it. A label missing from the map has no colour. */
export function TaskLabelColorsProvider({ value, children }: { value: Readonly<Record<string, TaskLabelColor>>; children: ReactNode }) {
  return <TaskLabelColorsContext.Provider value={value}>{children}</TaskLabelColorsContext.Provider>
}

/** A label's colour from the nearest TaskLabelColorsProvider; null with none, or when the label has no colour. */
export function useTaskLabelColor(name: string): TaskLabelColor | null {
  return useContext(TaskLabelColorsContext)?.[name] ?? null
}

/** The colour as a small round dot, as the chip leads with it. */
export function TaskLabelDot({ color, className }: { color: TaskLabelColor; className?: string }) {
  return <span aria-hidden='true' data-slot='task-label-dot' className={cn('size-2 shrink-0 rounded-full', DOT[color], className)} />
}

const VARIANTS = {
  /** On a card: a muted fill. */
  soft: 'bg-muted',
  /** In a table row: a border, no fill. */
  outline: 'border',
} as const

export interface TaskLabelChipProps extends Omit<ComponentProps<'span'>, 'children' | 'color'> {
  name: string
  /** The label's colour. Leave it out to take it from TaskLabelColorsProvider; null for none. */
  color?: TaskLabelColor | null
  variant?: keyof typeof VARIANTS
}

/**
 * A task's label as a small chip: the name, truncated, after a dot in the
 * label's colour. The full name is its tooltip. `className` sets its width
 * where it sits (`max-w-32` on a card, `shrink-0` in a table row).
 */
export function TaskLabelChip({ name, color, variant = 'soft', className, ...props }: TaskLabelChipProps) {
  const provided = useTaskLabelColor(name)
  const shown = color === undefined ? provided : color
  return (
    <span
      data-slot='task-label-chip'
      data-color={shown ?? undefined}
      title={name}
      className={cn('inline-flex h-5 min-w-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground', VARIANTS[variant], className)}
      {...props}
    >
      {shown ? <TaskLabelDot color={shown} /> : null}
      <span className='truncate'>{name}</span>
    </span>
  )
}
