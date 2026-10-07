import { AlertTriangle, Loader2, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

export interface TaskInlineCreateProps {
  /** Creates a task from the typed summary. A rejection keeps the text, and its message shows in the row. */
  onCreate: (summary: string) => Promise<unknown> | unknown
  /** The resting row's text. */
  label?: string
  placeholder?: string
  /** Open the field immediately (e.g. after "Add subtask"). */
  defaultOpen?: boolean
  /** Called when the field closes without creating anything more. */
  onClose?: () => void
  className?: string
}

/** A refusal's own words, without the transport's error-class prefix. */
function messageOf(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught)
  return raw.replace(/^[A-Za-z]*Error:\s*/, '') || 'Could not create the task'
}

/**
 * The quick way to add a task where a list ends: a quiet "Create task" row
 * that turns into a field on press. Type the summary, press Enter, and the
 * field clears for the next one; Escape, or leaving it empty, closes it.
 */
export function TaskInlineCreate({
  onCreate,
  label = 'Create task',
  placeholder = 'What needs to be done?',
  defaultOpen = false,
  onClose,
  className,
}: TaskInlineCreateProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [value, setValue] = useState('')
  // Creates in flight. The field clears on Enter, so the next summary can be
  // typed at once; each create waits for the one before, so they land in order.
  const [inFlight, setInFlight] = useState(0)
  // Why the last create was refused, shown in the row until the text changes.
  const [error, setError] = useState<string | null>(null)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      input.current?.focus()
    }
  }, [open])

  const close = () => {
    setOpen(false)
    setValue('')
    setError(null)
    onClose?.()
  }

  const submit = () => {
    const summary = value.trim()
    if (!summary) {
      return
    }
    setValue('')
    setError(null)
    setInFlight((count) => count + 1)
    queue.current = queue.current
      .then(() => onCreate(summary))
      .catch((caught: unknown) => {
        // The text comes back for a retry, unless something new is already being typed.
        setValue((current) => (current ? current : summary))
        setError(messageOf(caught))
      })
      .finally(() => setInFlight((count) => count - 1))
  }

  if (!open) {
    return (
      <button
        type="button"
        data-slot="task-inline-create"
        onClick={() => setOpen(true)}
        className={cn(
          'flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
          className,
        )}
      >
        <Plus className="size-4" />
        {label}
      </button>
    )
  }

  return (
    <div
      data-slot="task-inline-create"
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-md border border-ring/60 bg-background px-2 ring-2 ring-ring/20',
        error && 'border-destructive/60 ring-destructive/20',
        className,
      )}
    >
      {inFlight > 0 ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : <Plus className="size-4 shrink-0 text-muted-foreground" />}
      <input
        ref={input}
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          setError(null)
        }}
        aria-invalid={error ? true : undefined}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            close()
          }
        }}
        onBlur={() => {
          if (!value.trim() && inFlight === 0) {
            close()
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      {error ? (
        // In the row rather than under it, so the row keeps its height wherever it sits.
        <span role="alert" title={error} className="flex max-w-[60%] min-w-0 shrink items-center gap-1 text-xs text-destructive">
          <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{error}</span>
        </span>
      ) : (
        <kbd className="hidden shrink-0 rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground sm:inline">Enter</kbd>
      )}
    </div>
  )
}
