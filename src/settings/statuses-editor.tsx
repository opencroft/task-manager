// The project's statuses: rename, recategorise, recolour, reorder, add and
// delete (moving the deleted status's tasks elsewhere). The Board draws its
// columns from this list, in this order.

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { TaskEditableText } from '@/components/ui/tasks/task-editable-text'
import { TaskFieldPicker } from '@/components/ui/tasks/task-field-picker'
import { TaskStatusBadge } from '@/components/ui/tasks/task-status-badge'
import type { Status, StatusCategory } from '../../shared/types'
import { useProject } from '../app/project'

const CATEGORY_LABELS: Record<StatusCategory, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
}

const CATEGORY_OPTIONS = (Object.keys(CATEGORY_LABELS) as StatusCategory[]).map((category) => ({
  value: category,
  text: CATEGORY_LABELS[category],
  display: <TaskStatusBadge name={CATEGORY_LABELS[category]} category={category} size='sm' />,
}))

const COLORS = ['', '#64748b', '#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#ef4444']

function DeleteStatus({ status, others, onDone }: { status: Status; others: Status[]; onDone: () => void }) {
  const { api, fail } = useProject()
  const [target, setTarget] = useState(String(others[0]?.id ?? ''))
  const [busy, setBusy] = useState(false)
  return (
    <div className='flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm'>
      <span>Move its tasks to</span>
      <div className='w-40'>
        <TaskFieldPicker
          label='Move tasks to'
          value={target}
          options={others.map((other) => ({
            value: String(other.id),
            text: other.name,
            display: <TaskStatusBadge name={other.name} category={other.category} color={other.color} size='sm' />,
          }))}
          onChange={setTarget}
        />
      </div>
      <div className='ml-auto flex gap-2'>
        <Button variant='ghost' size='sm' onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant='destructive'
          size='sm'
          disabled={busy || !target}
          onClick={async () => {
            setBusy(true)
            try {
              await api.status_delete({ status: status.id, moveTo: Number(target) })
              onDone()
            } catch (error) {
              fail(error)
            } finally {
              setBusy(false)
            }
          }}
        >
          Delete {status.name}
        </Button>
      </div>
    </div>
  )
}

export function StatusesEditor() {
  const { api, statuses, fail } = useProject()
  const [deleting, setDeleting] = useState<number | null>(null)
  const [newName, setNewName] = useState('')

  const run = (promise: Promise<unknown>) => void promise.catch(fail)

  const move = (index: number, delta: number) => {
    const order = statuses.map((status) => status.id)
    const [id] = order.splice(index, 1)
    order.splice(index + delta, 0, id)
    run(api.status_reorder({ order }))
  }

  const add = () => {
    const name = newName.trim()
    if (!name) {
      return
    }
    run(api.status_create({ name, category: 'in_progress' }).then(() => setNewName('')))
  }

  return (
    <div className='flex flex-col gap-3'>
      <ol className='flex flex-col gap-1'>
        {statuses.map((status, index) => (
          <li key={status.id} className='flex flex-col gap-1'>
            <div className='flex flex-wrap items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/40'>
              <div className='flex flex-col'>
                <Button
                  variant='ghost'
                  size='icon-xs'
                  aria-label={`Move ${status.name} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  variant='ghost'
                  size='icon-xs'
                  aria-label={`Move ${status.name} down`}
                  disabled={index === statuses.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown />
                </Button>
              </div>
              <div className='min-w-0 flex-1 basis-40'>
                <TaskEditableText
                  value={status.name}
                  required
                  onSave={(name) =>
                    api.status_update({ status: status.id, name }).catch((e) => {
                      fail(e)
                      throw e
                    })
                  }
                />
              </div>
              <div className='w-32'>
                <TaskFieldPicker
                  label='Category'
                  value={status.category}
                  options={CATEGORY_OPTIONS}
                  onChange={(category) => run(api.status_update({ status: status.id, category }))}
                />
              </div>
              <div className='flex items-center gap-0.5' role='radiogroup' aria-label={`${status.name} colour`}>
                {COLORS.map((color) => (
                  // biome-ignore lint/a11y/useSemanticElements: a swatch button in the radiogroup above; a native radio input would be a different control, not the same one marked up differently
                  <button
                    key={color || 'default'}
                    type='button'
                    role='radio'
                    aria-checked={(status.color ?? '') === color}
                    aria-label={color ? `Colour ${color}` : 'Category colour'}
                    onClick={() => run(api.status_update({ status: status.id, color: color || null }))}
                    className='flex size-5 items-center justify-center rounded-full ring-offset-background aria-checked:ring-2 aria-checked:ring-ring aria-checked:ring-offset-1'
                  >
                    <span
                      className='size-3.5 rounded-full border'
                      style={{ background: color || 'conic-gradient(#94a3b8 0 33%, #3b82f6 0 66%, #10b981 0)' }}
                    />
                  </button>
                ))}
              </div>
              <Button
                variant='ghost'
                size='icon-sm'
                aria-label={`Delete ${status.name}`}
                disabled={statuses.length <= 1}
                onClick={() => setDeleting(deleting === status.id ? null : status.id)}
              >
                <Trash2 />
              </Button>
            </div>
            {deleting === status.id ? (
              <DeleteStatus
                status={status}
                others={statuses.filter((other) => other.id !== status.id)}
                onDone={() => setDeleting(null)}
              />
            ) : null}
          </li>
        ))}
      </ol>
      <form
        className='flex items-center gap-2'
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
      >
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder='New status name'
          aria-label='New status name'
          className='h-8 flex-1 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
        />
        <Button type='submit' size='sm' disabled={!newName.trim()}>
          <Plus />
          Add status
        </Button>
      </form>
    </div>
  )
}
