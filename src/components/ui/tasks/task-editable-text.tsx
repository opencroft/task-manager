import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'

export interface TaskEditableTextProps {
  value: string
  /** Saves the new value. A rejection puts the field back into editing with the typed text, and shows why under it. */
  onSave: (value: string) => Promise<unknown> | unknown
  placeholder?: string
  /** Refuse an empty value (a summary) instead of saving it. */
  required?: boolean
  /** Visual scale: `title` for a page heading, `text` for a field. */
  variant?: 'title' | 'text'
  /** Whether the field is open, for a host that starts editing itself (e.g. from a shortcut). Leave it out and a press opens it. */
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  className?: string
}

const VARIANT: Record<'title' | 'text', string> = {
  title: 'text-xl font-semibold leading-tight sm:text-2xl',
  text: 'text-sm',
}

/** A refusal's own words, without the transport's error-class prefix. */
function messageOf(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught)
  return raw.replace(/^[A-Za-z]*Error:\s*/, '') || 'Could not save'
}

/**
 * Text that reads as text and edits in place: press it to edit, Enter or
 * leaving the field saves, Escape puts it back. No edit mode to enter, no
 * save button to find.
 */
export function TaskEditableText({
  value,
  onSave,
  placeholder = 'Empty',
  required = false,
  variant = 'text',
  editing: editingProp,
  onEditingChange,
  className,
}: TaskEditableTextProps) {
  const [ownEditing, setOwnEditing] = useState(false)
  const editing = editingProp ?? ownEditing
  const setEditing = (next: boolean) => {
    setOwnEditing(next)
    onEditingChange?.(next)
  }
  const [draft, setDraft] = useState(value)
  // Why the last save was refused, shown under the field until the text changes.
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editing) {
      setDraft(value)
    }
  }, [value, editing])

  useEffect(() => {
    const el = field.current
    if (editing && el) {
      el.focus()
      el.select()
    }
  }, [editing])

  // The field grows with its content, so a long summary wraps instead of scrolling.
  useEffect(() => {
    const el = field.current
    if (el) {
      el.style.height = '0px'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [draft, editing])

  const commit = async () => {
    const next = draft.replace(/\s+/g, ' ').trim()
    if (next === value.trim() || (required && !next)) {
      setDraft(value)
      setEditing(false)
      return
    }
    setEditing(false)
    setError(null)
    try {
      await onSave(next)
    } catch (caught) {
      setDraft(next)
      setEditing(true)
      setError(messageOf(caught))
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        data-slot="task-editable-text"
        onClick={() => setEditing(true)}
        className={cn(
          '-mx-1.5 block w-[calc(100%+0.75rem)] rounded-md px-1.5 py-0.5 text-left break-words transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
          VARIANT[variant],
          !value && 'text-muted-foreground',
          className,
        )}
      >
        {value || placeholder}
      </button>
    )
  }

  return (
    <>
    <textarea
      ref={field}
      data-slot="task-editable-text"
      rows={1}
      value={draft}
      aria-label={placeholder}
      aria-invalid={error ? true : undefined}
      onChange={(event) => {
        setDraft(event.target.value)
        setError(null)
      }}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          setDraft(value)
          setError(null)
          setEditing(false)
        }
      }}
      className={cn(
        '-mx-1.5 block w-[calc(100%+0.75rem)] resize-none overflow-hidden rounded-md bg-background px-1.5 py-0.5 ring-2 ring-ring/50 outline-none',
        error && 'ring-destructive/50',
        VARIANT[variant],
        className,
      )}
    />
    {error ? (
      <p role="alert" className="mt-1 text-xs text-destructive">
        {error}
      </p>
    ) : null}
    </>
  )
}
