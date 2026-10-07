import { CircleAlert, Loader2, RotateCcw, X } from 'lucide-react'

import { Button } from '../button'
import { cn } from '@/lib/utils'

export interface TaskManagerErrorProps {
  /** What failed, in plain words: "Couldn't load the board", "Couldn't move TASK-12 to Done". */
  title: string
  /** The server's own message, shown as it came, e.g. a workflow's reason for refusing a move. */
  message?: string | null
  /** `page` replaces a page that could not load; `inline` sits above the content an action failed on. */
  variant?: 'page' | 'inline'
  /** Tries again. Without it there is no Retry button. */
  onRetry?: () => void
  /** The retry is running. */
  retrying?: boolean
  /** `inline`: closes the alert. */
  onDismiss?: () => void
  className?: string
}

/**
 * A failure the person should know about: what failed, the server's reason,
 * and a way to try again. A page that cannot load gets the page-sized state;
 * an action that was refused gets an inline alert that leaves the page usable.
 */
export function TaskManagerError({ title, message, variant = 'page', onRetry, retrying = false, onDismiss, className }: TaskManagerErrorProps) {
  const retry = onRetry ? (
    <Button variant='outline' size='sm' onClick={onRetry} disabled={retrying}>
      {retrying ? <Loader2 className='animate-spin' /> : <RotateCcw />}
      Retry
    </Button>
  ) : null

  if (variant === 'inline') {
    return (
      <div
        data-slot='task-manager-error'
        data-variant='inline'
        role='alert'
        className={cn('flex w-full min-w-0 items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm', className)}
      >
        <CircleAlert aria-hidden='true' className='mt-0.5 size-4 shrink-0 text-destructive' />
        <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
          <p className='font-medium text-foreground'>{title}</p>
          {message ? <p className='text-muted-foreground [overflow-wrap:anywhere]'>{message}</p> : null}
        </div>
        <div className='-my-1 flex shrink-0 items-center gap-1'>
          {retry}
          {onDismiss ? (
            <Button variant='ghost' size='icon-sm' aria-label='Dismiss' onClick={onDismiss}>
              <X />
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div
      data-slot='task-manager-error'
      data-variant='page'
      role='alert'
      className={cn('mx-auto flex w-full max-w-md flex-col items-center gap-4 px-4 py-12 text-center', className)}
    >
      <span aria-hidden='true' className='flex size-12 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive'>
        <CircleAlert className='size-6' />
      </span>
      <div className='flex min-w-0 flex-col gap-1.5'>
        <h2 className='text-lg font-semibold text-foreground'>{title}</h2>
        {message ? <p className='text-sm text-pretty text-muted-foreground [overflow-wrap:anywhere]'>{message}</p> : null}
      </div>
      {retry}
    </div>
  )
}
