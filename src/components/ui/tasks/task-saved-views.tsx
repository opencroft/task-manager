import { Bookmark, Check, ChevronDown, Pencil, Plus, Star, Trash2, UserRound, Users } from 'lucide-react'
import { type KeyboardEvent, useState } from 'react'

import { Button } from '../button'
import { Checkbox } from '../checkbox'
import { Input } from '../input'
import { Popover, PopoverContent, PopoverTrigger } from '../popover'
import { cn } from '@/lib/utils'

import { ItemActionsMenu, ItemContextMenu, type ItemMenuEntries } from './item-menu'

export interface TaskSavedView {
  id: string
  name: string
  /** Shared with the project, rather than kept by the person who saved it. */
  shared: boolean
  /** The view a page opens on. */
  isDefault?: boolean
  /** Who saved a shared view, when it was someone else. */
  owner?: string
  /** False for a shared view this person may not change: it can still be used and made their default. */
  editable?: boolean
}

export interface TaskSavedViewsListProps {
  views: TaskSavedView[]
  /** The view the page shows now. */
  activeId?: string | null
  /** The page's filters, sort or grouping differ from the active view's. */
  modified?: boolean
  onSelect: (id: string) => void
  /** Saves the page's current filters, sort and grouping as a new view. */
  onSaveAs?: (name: string, shared: boolean) => void
  /** Writes the current filters into the active view. */
  onSave?: () => void
  /** Puts the page back to the active view's filters. */
  onReset?: () => void
  onRename?: (id: string, name: string) => void
  onDelete?: (id: string) => void
  onSetDefault?: (id: string) => void
  onSharedChange?: (id: string, shared: boolean) => void
  className?: string
}

export interface TaskSavedViewsProps extends TaskSavedViewsListProps {
  /** Shown on the picker when no view is active. */
  placeholder?: string
}

function ModifiedDot({ className }: { className?: string }) {
  return <span aria-hidden='true' className={cn('size-1.5 shrink-0 rounded-full bg-primary', className)} />
}

function NameField({
  defaultValue = '',
  placeholder,
  label,
  onSubmit,
  onCancel,
}: {
  defaultValue?: string
  placeholder: string
  label: string
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(defaultValue)
  const submit = () => {
    const name = value.trim()
    if (name) {
      onSubmit(name)
    } else {
      onCancel()
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape') {
      // Close the field, not the popover around it.
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }
  return (
    <Input
      autoFocus
      value={value}
      placeholder={placeholder}
      aria-label={label}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={submit}
      className='h-8'
    />
  )
}

/** The form that names the current filters as a new view. Enter or Save keeps it; Esc or Cancel drops it. */
function NewView({ onSave, onCancel }: { onSave: (name: string, shared: boolean) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [share, setShare] = useState(false)
  const save = () => {
    if (name.trim()) {
      onSave(name.trim(), share)
    }
  }
  return (
    <div className='flex flex-col gap-2 p-1'>
      <Input
        autoFocus
        value={name}
        placeholder='Name this view'
        aria-label='New view name'
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            save()
          } else if (event.key === 'Escape') {
            // Close the form, not the popover around it.
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          }
        }}
        className='h-8'
      />
      <div className='flex min-w-0 items-center gap-2'>
        <label className='flex min-w-0 flex-1 items-center gap-2 px-0.5 text-xs text-muted-foreground'>
          <Checkbox checked={share} onCheckedChange={(checked) => setShare(checked === true)} />
          <span className='truncate'>Share with the project</span>
        </label>
        <Button variant='ghost' size='xs' onClick={onCancel}>
          Cancel
        </Button>
        <Button size='xs' disabled={!name.trim()} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  )
}

function ViewRow({
  view,
  active,
  modified,
  onSelect,
  onRename,
  onDelete,
  onSetDefault,
  onSharedChange,
}: {
  view: TaskSavedView
  active: boolean
  modified: boolean
} & Pick<TaskSavedViewsListProps, 'onSelect' | 'onRename' | 'onDelete' | 'onSetDefault' | 'onSharedChange'>) {
  const [renaming, setRenaming] = useState(false)
  const editable = view.editable !== false
  const canRename = editable && onRename
  const canShare = editable && onSharedChange
  const canDelete = editable && onDelete
  // One list for the row's … and its context menu. Delete asks first, in the host.
  const entries: ItemMenuEntries = [
    canRename && { id: 'rename', label: 'Rename', icon: Pencil, onSelect: () => setRenaming(true) },
    onSetDefault && !view.isDefault && { id: 'default', label: 'Make it the default', icon: Star, onSelect: () => onSetDefault(view.id) },
    canShare && {
      id: 'share',
      label: view.shared ? 'Keep it personal' : 'Share with the project',
      icon: view.shared ? UserRound : Users,
      onSelect: () => onSharedChange(view.id, !view.shared),
    },
    canDelete && { id: 'delete', label: 'Delete…', icon: Trash2, destructive: true, onSelect: () => onDelete(view.id) },
  ]

  if (renaming && onRename) {
    return (
      <li className='px-1 py-0.5'>
        <NameField
          defaultValue={view.name}
          placeholder='View name'
          label={`Rename ${view.name}`}
          onSubmit={(name) => {
            setRenaming(false)
            if (name !== view.name) {
              onRename(view.id, name)
            }
          }}
          onCancel={() => setRenaming(false)}
        />
      </li>
    )
  }

  return (
    <ItemContextMenu entries={entries} render={<li />} className='group/view flex min-w-0 items-center gap-0.5'>
      <button
        type='button'
        aria-current={active ? 'true' : undefined}
        onClick={() => onSelect(view.id)}
        className={cn(
          'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
          active && 'bg-muted font-medium',
        )}
      >
        <Check className={cn('size-3.5 shrink-0', active ? 'text-foreground' : 'invisible')} />
        <span className='min-w-0 truncate'>{view.name}</span>
        {active && modified ? <ModifiedDot /> : null}
        {active && modified ? <span className='sr-only'>(modified)</span> : null}
        <span className='ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground'>
          {view.owner ? <span className='max-w-24 truncate text-xs font-normal'>{view.owner}</span> : null}
          {view.isDefault ? (
            <span title='The default view'>
              <Star className='size-3.5 fill-current' aria-hidden='true' />
              <span className='sr-only'>Default</span>
            </span>
          ) : null}
        </span>
      </button>
      <ItemActionsMenu entries={entries} label={`Actions for ${view.name}`} />
    </ItemContextMenu>
  )
}

/** The saved views as a list: personal ones, then shared, then a field to save the current filters as a new one. */
export function TaskSavedViewsList({
  views,
  activeId = null,
  modified = false,
  onSelect,
  onSaveAs,
  onSave,
  onReset,
  onRename,
  onDelete,
  onSetDefault,
  onSharedChange,
  className,
}: TaskSavedViewsListProps) {
  const [saving, setSaving] = useState(false)
  const active = views.find((view) => view.id === activeId) ?? null
  const personal = views.filter((view) => !view.shared)
  const shared = views.filter((view) => view.shared)
  const canSaveActive = Boolean(onSave && active && active.editable !== false)

  const groups = [
    { id: 'personal', title: 'Personal', icon: Bookmark, items: personal },
    { id: 'shared', title: 'Shared with the project', icon: Users, items: shared },
  ].filter((group) => group.items.length > 0)

  return (
    <div data-slot='task-saved-views-list' className={cn('flex min-w-0 flex-col gap-1', className)}>
      {active && modified && (canSaveActive || onReset) ? (
        <div className='flex min-w-0 items-center gap-2 rounded-md bg-primary/5 px-2 py-1.5 text-xs'>
          <ModifiedDot />
          <span className='min-w-0 flex-1 truncate text-muted-foreground'>
            <span className='font-medium text-foreground'>{active.name}</span> has unsaved changes
          </span>
          {onReset ? (
            <Button variant='ghost' size='xs' onClick={onReset}>
              Reset
            </Button>
          ) : null}
          {canSaveActive && onSave ? (
            <Button size='xs' onClick={onSave}>
              Save
            </Button>
          ) : null}
        </div>
      ) : null}

      {groups.length === 0 ? (
        <p className='px-2 py-3 text-sm text-muted-foreground'>
          No saved views yet. Set the filters and sort you come back to, then save them here.
        </p>
      ) : (
        groups.map((group) => {
          const Icon = group.icon
          return (
            <section key={group.id} aria-label={group.title} className='flex min-w-0 flex-col'>
              <h3 className='flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground'>
                <Icon className='size-3.5' aria-hidden='true' />
                {group.title}
              </h3>
              <ul className='flex min-w-0 flex-col'>
                {group.items.map((view) => (
                  <ViewRow
                    key={view.id}
                    view={view}
                    active={view.id === activeId}
                    modified={modified}
                    onSelect={onSelect}
                    onRename={onRename}
                    onDelete={onDelete}
                    onSetDefault={onSetDefault}
                    onSharedChange={onSharedChange}
                  />
                ))}
              </ul>
            </section>
          )
        })
      )}

      {onSaveAs ? (
        <div className='mt-1 border-t pt-1'>
          {saving ? (
            <NewView
              onSave={(name, share) => {
                onSaveAs(name, share)
                setSaving(false)
              }}
              onCancel={() => setSaving(false)}
            />
          ) : (
            <Button variant='ghost' size='sm' className='w-full justify-start px-2' onClick={() => setSaving(true)}>
              <Plus />
              {modified || !active ? 'Save the current filters as a view' : 'Save as a new view'}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The page header's view picker: the active view's name, a dot once its
 * filters have been changed, and Save and Reset beside it. Opens the list.
 */
export function TaskSavedViews({ placeholder = 'Views', className, onSelect, ...list }: TaskSavedViewsProps) {
  const [open, setOpen] = useState(false)
  const active = list.views.find((view) => view.id === list.activeId) ?? null
  const modified = Boolean(active && list.modified)
  const canSave = Boolean(list.onSave && active && active.editable !== false)

  return (
    <div data-slot='task-saved-views' className={cn('flex min-w-0 items-center gap-1', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button variant='outline' size='sm' className='min-w-0 max-w-56' />}>
          <Bookmark className='text-muted-foreground' />
          <span className='min-w-0 truncate'>{active ? active.name : placeholder}</span>
          {modified ? <ModifiedDot /> : null}
          {modified ? <span className='sr-only'>(modified)</span> : null}
          <ChevronDown className='text-muted-foreground' />
        </PopoverTrigger>
        <PopoverContent align='start' className='w-72 gap-0 p-1'>
          <TaskSavedViewsList
            {...list}
            onSelect={(id) => {
              onSelect(id)
              setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
      {modified ? (
        <>
          {list.onReset ? (
            <Button variant='ghost' size='sm' className='hidden sm:inline-flex' onClick={list.onReset}>
              Reset
            </Button>
          ) : null}
          {canSave && list.onSave ? (
            <Button variant='ghost' size='sm' className='hidden text-primary sm:inline-flex' onClick={list.onSave}>
              Save
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
