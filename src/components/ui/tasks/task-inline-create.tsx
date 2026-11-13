import { AlertTriangle, Loader2, Plus, X } from 'lucide-react'
import { type FocusEvent, useEffect, useRef, useState } from 'react'

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

/**
 * What the open field does on each way out of typing: Enter creates and stays
 * open for the next summary, leaving the field (focus moves elsewhere) creates
 * what was typed, and Escape or the × discards it. With nothing typed, leaving
 * closes the field and Enter does nothing.
 */
export function inlineCreateAction(event: 'enter' | 'leave' | 'escape' | 'cancel', value: string): 'create' | 'close' | 'none' {
  const typed = value.trim() !== ''
  switch (event) {
    case 'enter':
      return typed ? 'create' : 'none'
    case 'leave':
      return typed ? 'create' : 'close'
    case 'escape':
    case 'cancel':
      return 'close'
  }
}

/** A refusal's own words, without the transport's error-class prefix. */
function messageOf(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught)
  return raw.replace(/^[A-Za-z]*Error:\s*/, '') || 'Could not create the task'
}

/**
 * The quick way to add a task where a list ends: a quiet "Create task" row
 * that turns into a field on press. Type the summary and press Enter, and the
 * field clears for the next one; click or tab away, and what was typed is
 * created and the field closes. Escape or the × closes it without creating.
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
  // Focus has left the field: it closes once nothing is left to create or to show.
  const [left, setLeft] = useState(false)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const input = useRef<HTMLInputElement>(null)
  const row = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      input.current?.focus()
    }
  }, [open])

  // Set while the field closes, so a blur the browser sends as the input goes is not taken for leaving with text.
  const closing = useRef(false)
  useEffect(() => {
    if (open) {
      closing.current = false
    }
  }, [open])

  const close = () => {
    closing.current = true
    setOpen(false)
    setValue('')
    setError(null)
    setLeft(false)
    onClose?.()
  }

  // A create sent on leaving lands before the field closes, so a refusal still has a row to show in.
  useEffect(() => {
    if (open && left && inFlight === 0 && value.trim() === '' && error === null) {
      close()
    }
  })

  const submit = () => {
    const summary = value.trim()
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

  const act = (event: Parameters<typeof inlineCreateAction>[0]) => {
    const action = inlineCreateAction(event, value)
    if (action === 'create') {
      submit()
    } else if (action === 'close') {
      close()
    }
  }

  // Focus moving between the input and the × stays inside the field; only leaving it altogether counts.
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (closing.current || (event.relatedTarget instanceof Node && row.current?.contains(event.relatedTarget))) {
      return
    }
    // Closing waits for the effect above, so creates still in flight land first.
    setLeft(true)
    if (inlineCreateAction('leave', value) === 'create') {
      submit()
    }
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
      ref={row}
      data-slot="task-inline-create"
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-md border border-ring/60 bg-background pr-0.5 pl-2 ring-2 ring-ring/20',
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
            act('enter')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            act('escape')
          }
        }}
        onFocus={() => setLeft(false)}
        onBlur={onBlur}
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
      ) : null}
      <button
        type="button"
        aria-label="Cancel"
        title="Cancel"
        // Pressed with a pointer, the × keeps the focus in the input, so the press is not a leave that creates.
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => act('cancel')}
        onFocus={() => setLeft(false)}
        onBlur={onBlur}
        className="flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
