import { cn } from '@/lib/utils'

export type TimelinePane = 'scale' | 'list' | 'backlog'

const PANES: { id: TimelinePane; label: string }[] = [
  { id: 'scale', label: 'Scale' },
  { id: 'list', label: 'List' },
  { id: 'backlog', label: 'Backlog' },
]

export interface TimelinePaneSwitchProps {
  value: TimelinePane
  onValueChange: (pane: TimelinePane) => void
  /** How many tasks wait in the backlog, shown on its tab. */
  backlogCount?: number
  className?: string
}

/** The timeline on a narrow screen shows one pane at a time: the scale, the task list or the backlog. */
export function TimelinePaneSwitch({ value, onValueChange, backlogCount, className }: TimelinePaneSwitchProps) {
  return (
    <div role='tablist' aria-label='Timeline pane' className={cn('grid grid-cols-3 gap-1 rounded-lg bg-muted p-1', className)}>
      {PANES.map((pane) => {
        const selected = pane.id === value
        return (
          <button
            key={pane.id}
            type='button'
            role='tab'
            aria-selected={selected}
            onClick={() => onValueChange(pane.id)}
            className={cn(
              'inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
              selected ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {pane.label}
            {pane.id === 'backlog' && backlogCount ? <span className='text-xs text-muted-foreground tabular-nums'>{backlogCount}</span> : null}
          </button>
        )
      })}
    </div>
  )
}
