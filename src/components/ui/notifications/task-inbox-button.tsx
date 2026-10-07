import { Bell } from 'lucide-react'
import type { ComponentProps } from 'react'

import { Button } from '../button'
import { cn } from '@/lib/utils'

export interface TaskInboxButtonProps extends Omit<ComponentProps<typeof Button>, 'children'> {
  /** Unread notifications, over every kind. 0 hides the badge. */
  count: number
  /** The badge reads `max+` past this. */
  max?: number
}

/**
 * The header's bell with the unread count on a badge. Every other prop goes to
 * the button, so it can be a popover's trigger as it is.
 */
export function TaskInboxButton({ count, max = 99, variant = 'ghost', size = 'icon-sm', className, ...props }: TaskInboxButtonProps) {
  const unread = Math.max(0, Math.floor(count))
  const shown = unread > max ? `${max}+` : String(unread)
  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'
  return (
    <Button
      data-slot='task-inbox-button'
      data-unread={unread > 0 || undefined}
      variant={variant}
      size={size}
      aria-label={label}
      title={label}
      className={cn('relative', className)}
      {...props}
    >
      <Bell aria-hidden='true' />
      {unread > 0 ? (
        <span
          aria-hidden='true'
          className='pointer-events-none absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground tabular-nums ring-2 ring-background'
        >
          {shown}
        </span>
      ) : null}
    </Button>
  )
}
