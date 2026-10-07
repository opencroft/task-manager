import { Plus, X } from 'lucide-react'
import { useId, useState } from 'react'

import { cn } from '@/lib/utils'

import { ItemContextMenu, type ItemMenuEntries } from './item-menu'
import { TaskLabelDot, useTaskLabelColor } from './task-label-chip'

/** A label's colour from the TaskLabelColorsProvider above, as the dot before its name; nothing without one. */
function LabelColor({ label }: { label: string }) {
  const color = useTaskLabelColor(label)
  return color ? <TaskLabelDot color={color} className='mr-0.5' /> : null
}

export interface TaskLabelsEditorProps {
  labels: string[]
  onChange: (labels: string[]) => void
  /** Labels used elsewhere in the project, offered while typing. */
  suggestions?: string[]
  /**
   * More entries for a chip's menu (right-click, long press, or Shift+F10 on
   * its ×), before its own Remove: e.g. show the tasks with this label.
   */
  labelMenu?: (label: string) => ItemMenuEntries
  className?: string
}

/**
 * A task's labels as removable chips, with a field at the end that adds one
 * on Enter (or a comma) and suggests the project's existing labels.
 */
export function TaskLabelsEditor({ labels, onChange, suggestions = [], labelMenu, className }: TaskLabelsEditorProps) {
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const listId = useId()

  const add = (raw: string) => {
    const label = raw.replace(/\s+/g, ' ').trim().replace(/,$/, '')
    setDraft('')
    if (label && !labels.some((existing) => existing.toLowerCase() === label.toLowerCase())) {
      onChange([...labels, label])
    }
  }

  return (
    <div data-slot="task-labels-editor" className={cn('-mx-1.5 flex min-h-8 flex-wrap items-center gap-1 px-1.5', className)}>
      {labels.map((label) => (
        <ItemContextMenu
          key={label}
          entries={[
            ...(labelMenu?.(label) ?? []),
            { id: 'remove', label: 'Remove label', icon: X, onSelect: () => onChange(labels.filter((existing) => existing !== label)) },
          ]}
          render={<span />}
          className="group/label inline-flex h-6 items-center gap-0.5 rounded-md border bg-muted/40 pr-0.5 pl-2 text-xs"
        >
          <LabelColor label={label} />
          {label}
          <button
            type="button"
            aria-label={`Remove label ${label}`}
            onClick={() => onChange(labels.filter((existing) => existing !== label))}
            className="inline-flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-3" />
          </button>
        </ItemContextMenu>
      ))}
      {adding ? (
        <>
          <input
            // biome-ignore lint/a11y/noAutofocus: opened by an explicit press
            autoFocus
            list={listId}
            value={draft}
            placeholder="Label"
            aria-label="New label"
            onChange={(event) => {
              const value = event.target.value
              if (value.endsWith(',')) {
                add(value)
              } else {
                setDraft(value)
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                add(draft)
              } else if (event.key === 'Escape') {
                setDraft('')
                setAdding(false)
              } else if (event.key === 'Backspace' && !draft && labels.length) {
                onChange(labels.slice(0, -1))
              }
            }}
            onBlur={() => {
              add(draft)
              setAdding(false)
            }}
            className="h-6 w-28 rounded-md border bg-background px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <datalist id={listId}>
            {suggestions
              .filter((suggestion) => !labels.includes(suggestion))
              .map((suggestion) => (
                <option key={suggestion} value={suggestion} />
              ))}
          </datalist>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Plus className="size-3" />
          {labels.length ? 'Add' : 'Add label'}
        </button>
      )}
    </div>
  )
}
