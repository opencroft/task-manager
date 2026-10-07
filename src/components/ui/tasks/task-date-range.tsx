import { CalendarRange, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface TaskDateRangeProps {
  /** `YYYY-MM-DD`, or null when unscheduled. */
  startDate: string | null
  /** `YYYY-MM-DD`, inclusive, or null when unscheduled. */
  endDate: string | null
  /** Reports the new range; both null clears the schedule. */
  onChange: (range: { startDate: string | null; endDate: string | null }) => void
  className?: string
}

function parse(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

function today(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** "Sep 26 – Oct 10", with the year only when the range leaves the current one. */
export function formatDateRange(start: string, end: string): string {
  const a = parse(start)
  const b = parse(end)
  const thisYear = new Date().getFullYear()
  const withYear = a.getFullYear() !== thisYear || b.getFullYear() !== thisYear
  const format = (date: Date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) })
  const days = Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1
  return start === end ? format(a) : `${format(a)} – ${format(b)} · ${days}d`
}

const FIELD =
  'h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [color-scheme:light] dark:[color-scheme:dark]'

/**
 * A task's schedule: a start and an end day, both or neither. Reads as the
 * range and its length; pressing it opens the two day fields. Unscheduled
 * reads "Schedule", and a press sets a five-day range starting today. Editing
 * one side moves the other when the range would cross.
 */
export function TaskDateRange({ startDate, endDate, onChange, className }: TaskDateRangeProps) {
  const scheduled = Boolean(startDate && endDate)
  return (
    <Popover>
      <PopoverTrigger
        data-slot="task-date-range"
        onClick={() => {
          if (!scheduled) {
            const start = today()
            onChange({ startDate: start, endDate: addDays(start, 4) })
          }
        }}
        className={cn(
          '-mx-1.5 flex h-8 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-sm transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none data-popup-open:bg-muted/70',
          !scheduled && 'text-muted-foreground',
          className,
        )}
      >
        <CalendarRange className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{scheduled ? formatDateRange(startDate as string, endDate as string) : 'Schedule'}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-72 flex-col gap-3 p-3">
        {scheduled ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Start
                <input
                  type="date"
                  value={startDate as string}
                  onChange={(event) => {
                    const start = event.target.value
                    if (start) {
                      onChange({ startDate: start, endDate: (endDate as string) < start ? start : endDate })
                    }
                  }}
                  className={FIELD}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                End
                <input
                  type="date"
                  value={endDate as string}
                  min={startDate as string}
                  onChange={(event) => {
                    const end = event.target.value
                    if (end) {
                      onChange({ startDate: end < (startDate as string) ? end : startDate, endDate: end })
                    }
                  }}
                  className={FIELD}
                />
              </label>
            </div>
            <Button variant="ghost" size="sm" className="self-start text-muted-foreground" onClick={() => onChange({ startDate: null, endDate: null })}>
              <X />
              Clear schedule
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Scheduling from today…</p>
        )}
      </PopoverContent>
    </Popover>
  )
}
