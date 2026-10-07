// A task's details, as its page and the peek both show them: every field
// editable in place, the description in the host's markdown editor,
// attachments (dropped or pasted anywhere on it), subtasks with inline create,
// dependencies, the workflow panel, comments (a pasted image is attached and
// shown inline) and history. Links to other tasks open where this surface
// opens tasks: the page moves on a task's page, the peek follows in a peek.

import { MarkdownEditor } from '@opencroft/client'
import { cn } from 'cn'
import { CircleDot, Copy, ExternalLink, Link2, ListFilter, Pencil, Trash2, Unlink } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { type ItemMenuAction, type ItemMenuEntries, ItemContextMenu } from '@/components/ui/tasks/item-menu'
import { TaskActivity } from '@/components/ui/tasks/task-activity'
import { TaskAssignee } from '@/components/ui/tasks/task-assignee'
import { TaskAttachmentDropZone, TaskAttachments } from '@/components/ui/tasks/task-attachments'
import { TaskComments } from '@/components/ui/tasks/task-comments'
import { TaskDateRange } from '@/components/ui/tasks/task-date-range'
import { TaskDependencies } from '@/components/ui/tasks/task-dependencies'
import { TaskDetailsField, TaskDetailsLayout, TaskDetailsSection } from '@/components/ui/tasks/task-details-layout'
import { TaskEditableText } from '@/components/ui/tasks/task-editable-text'
import { TaskFieldPicker } from '@/components/ui/tasks/task-field-picker'
import { TaskInlineCreate } from '@/components/ui/tasks/task-inline-create'
import { TaskLabelsEditor } from '@/components/ui/tasks/task-labels-editor'
import { TaskActionsMenu, TaskContextMenu, taskFieldEntries } from '@/components/ui/tasks/task-menu'
import { TASK_PRIORITIES, TASK_PRIORITY_LABELS, TaskPriorityIcon } from '@/components/ui/tasks/task-priority-icon'
import { TaskPullRequests } from '@/components/ui/tasks/task-pull-requests'
import { TaskStatusBadge } from '@/components/ui/tasks/task-status-badge'
import { TaskSubtaskList } from '@/components/ui/tasks/task-subtask-list'
import { TASK_TYPES, TASK_TYPE_LABELS, TaskTypeIcon } from '@/components/ui/tasks/task-type-icon'
import { taskVersionOptions } from '@/components/ui/tasks/task-version-chip'

import { RELATION_GROUPS, RELATION_WORDS, type RelationGroup, relationInput } from '../../shared/dependencies'
import type { Priority, Task, TaskSummary, TaskType } from '../../shared/types'
import { copyText, useProject } from '../app/project'
import { openTask, taskHref, useTaskLink } from '../app/task-opener'
import { CommentBody } from '../attachments/comment-body'
import { useTaskAttachments } from '../attachments/use-task-attachments'
import { errorMessage } from '../lib/api'
import { assigneeInput, assigneeKey } from '../lib/assignees'
import { toTaskVersion } from '../lib/versions'
import { absoluteLink, hrefFor, navigate, useQueryParam } from '../lib/router'
import { MentionSessions } from '../mentions/mention-sessions'
import { WorkflowPanel } from '../workflows/task-panel'
import type { TaskDetailsState } from './use-task-details'

function formatStamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * The pull requests mentioning a task. Whether a forge is connected is asked
 * only while the task has none, to say why the list is empty; a task with
 * pull requests needs no answer and costs no call.
 */
function PullRequests({ task }: { task: Task }) {
  const { api } = useProject()
  const empty = task.pullRequests.length === 0
  const [connected, setConnected] = useState(true)
  useEffect(() => {
    if (!empty) {
      return
    }
    let live = true
    api.forge_status({}).then(
      (status) => live && setConnected(status.connection !== null),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [api, empty])
  return (
    <TaskDetailsSection title={empty ? 'Pull requests' : `Pull requests (${task.pullRequests.length})`}>
      <TaskPullRequests pullRequests={task.pullRequests} taskKey={task.key} connected={connected} />
    </TaskDetailsSection>
  )
}

function Description({
  task,
  onSave,
  renderBody,
}: {
  task: Task
  onSave: (description: string) => Promise<void>
  /** The description as shown: markdown, with the task's attachment images drawn in place. */
  renderBody: (body: string) => ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(task.description)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!editing) {
      setDraft(task.description)
    }
  }, [task.description, editing])

  if (!editing) {
    return (
      <TaskDetailsSection
        title="Description"
        actions={
          task.description ? (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              <Pencil />
              Edit
            </Button>
          ) : null
        }
      >
        {task.description ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: a double-click shortcut; the Edit button is the keyboard path
          <div onDoubleClick={() => setEditing(true)}>
            {renderBody(task.description)}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-md border border-dashed px-3 py-4 text-left text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            Add a description…
          </button>
        )}
      </TaskDetailsSection>
    )
  }

  const save = async () => {
    setSaving(true)
    try {
      await onSave(draft)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <TaskDetailsSection title="Description">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: it takes no focus; it hears the keys typed in the editor inside it */}
      <div
        className="flex flex-col gap-2"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void save()
          } else if (event.key === 'Escape') {
            setDraft(task.description)
            setEditing(false)
          }
        }}
      >
        <MarkdownEditor value={draft} onChange={setDraft} autoFocus placeholder="Describe the task…" className="min-h-40 rounded-md border" />
        <div className="flex items-center justify-end gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">Ctrl + Enter to save · Esc to cancel</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => {
              setDraft(task.description)
              setEditing(false)
            }}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </TaskDetailsSection>
  )
}

export interface TaskDetailsProps extends Pick<TaskDetailsState, 'load' | 'update'> {
  task: Task
  /** The Dependencies picker's choices. */
  candidates: TaskSummary[]
  /** In the peek, whose header already shows the key, the type and the task menu. */
  inPeek?: boolean
}

export function TaskDetails({ task, load, update, candidates, inPeek = false }: TaskDetailsProps) {
  const { api, instanceId, projectKey, statuses, assignees, labels, versions, menuFor, confirm } = useProject()
  const kitVersions = useMemo(() => versions.map(toTaskVersion), [versions])
  // The task names its version; the picker keys versions by id.
  const versionId = task.version ? (kitVersions.find((version) => version.name === task.version?.name)?.id ?? '') : ''
  const linkTo = useTaskLink()
  const [add, setAdd] = useQueryParam('add')
  const [edit, setEdit] = useQueryParam('edit')
  const [tab, setTab] = useState<'comments' | 'activity'>('comments')
  // A link to a comment (`?comment=12`) shows the comments with that one in view.
  const [commentParam] = useQueryParam('comment')
  const linkedComment = commentParam ? Number(commentParam) : null
  const [editingComment, setEditingComment] = useState<number | null>(null)
  const commentsRef = useRef<HTMLElement>(null)
  const subtaskRef = useRef<HTMLDivElement>(null)
  const attachments = useTaskAttachments(api, instanceId, task.key)

  useEffect(() => {
    if (add === 'subtask') {
      subtaskRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [add])

  useEffect(() => {
    if (linkedComment === null) {
      return
    }
    setTab('comments')
    requestAnimationFrame(() =>
      commentsRef.current?.querySelector(`[data-comment-id="${linkedComment}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    )
  }, [linkedComment])

  const commentMenu = (id: number | string): ItemMenuEntries => {
    const comment = task.comments.find((candidate) => candidate.id === id)
    if (!comment) {
      return []
    }
    return [
      {
        id: 'copy-link',
        label: 'Copy link',
        icon: Link2,
        group: 'open',
        onSelect: () => void copyText(absoluteLink(hrefFor(['task', task.key], { comment: String(comment.id) })), 'link to the comment'),
      },
      { id: 'copy-text', label: 'Copy text', icon: Copy, group: 'open', onSelect: () => void copyText(comment.body, 'the comment') },
      comment.mine && { id: 'edit', label: 'Edit', icon: Pencil, onSelect: () => setEditingComment(comment.id) },
      comment.mine && {
        id: 'delete',
        label: 'Delete…',
        icon: Trash2,
        destructive: true,
        onSelect: () =>
          confirm({
            title: 'Delete this comment?',
            description: 'It is removed from the task for everyone. It cannot be undone.',
            action: 'Delete',
            destructive: true,
            onConfirm: async () => {
              await api.task_comment_delete({ key: task.key, id: comment.id })
              await load()
            },
          }),
      },
    ]
  }

  // A related task's row: open or copy it, change its status, or remove the relation after a confirm.
  const dependencyMenu = (relation: RelationGroup, item: TaskSummary): ItemMenuEntries => {
    const input = relationInput(relation, task.key, item.key)
    return [
      { id: 'open', label: 'Open', icon: ExternalLink, group: 'open', onSelect: () => openTask(item.key) },
      { id: 'copy-key', label: 'Copy key', icon: Copy, group: 'open', onSelect: () => void copyText(item.key, item.key) },
      { id: 'copy-link', label: 'Copy link', icon: Link2, group: 'open', onSelect: () => void copyText(absoluteLink(taskHref(item.key)), `link to ${item.key}`) },
      { id: 'status', label: 'Status', icon: CircleDot, group: 'change', entries: taskFieldEntries(menuFor(item), 'status') as ItemMenuAction[] },
      {
        id: 'unlink',
        label: 'Remove relation…',
        icon: Unlink,
        destructive: true,
        onSelect: () =>
          confirm({
            title: `Remove "${input.from} ${RELATION_WORDS[input.type]} ${input.to}"?`,
            description: input.type === 'blocks' ? `${input.to} will no longer wait for ${input.from}.` : 'Both tasks stay as they are.',
            action: 'Remove relation',
            onConfirm: async () => {
              await api.task_unlink(input)
              await load()
            },
          }),
      },
    ]
  }

  const menu = menuFor(task)

  const details = (
    <TaskDetailsLayout
      breadcrumbs={[
        ...(inPeek ? [] : [{ label: projectKey, href: hrefFor(['tasks']) }]),
        ...task.ancestors.map((a) => ({ label: `${a.key} ${a.summary}`, href: linkTo(a.key) })),
      ]}
      identity={
        inPeek ? null : (
          <>
            <TaskTypeIcon type={task.type} />
            <TaskContextMenu {...menu} render={<span />}>
              <button
                type="button"
                onClick={menu.onCopyKey}
                title="Copy key"
                className="rounded px-1 font-mono text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {task.key}
              </button>
            </TaskContextMenu>
          </>
        )
      }
      actions={
        inPeek ? null : (
          <>
            <Button variant="ghost" size="icon-sm" aria-label="Copy link" title="Copy link" onClick={menu.onCopyLink}>
              <Link2 />
            </Button>
            <TaskActionsMenu {...menu} onOpen={undefined} onAddSubtask={() => setAdd('subtask')} />
          </>
        )
      }
      title={
        <TaskEditableText
          value={task.summary}
          required
          variant="title"
          placeholder="Summary"
          onSave={(summary) => update({ summary })}
          editing={edit === 'summary'}
          onEditingChange={(editing) => setEdit(editing ? 'summary' : null)}
        />
      }
      fields={
        <>
          <TaskDetailsField label="Status">
            <TaskFieldPicker
              label="Status"
              value={String(task.status.id)}
              options={statuses.map((status) => ({
                value: String(status.id),
                text: status.name,
                display: <TaskStatusBadge name={status.name} category={status.category} color={status.color} />,
              }))}
              onChange={(id) => void update({ status: Number(id) }).catch(() => {})}
            />
          </TaskDetailsField>
          <TaskDetailsField label="Assignee">
            <TaskFieldPicker
              label="Assignee"
              value={assigneeKey(task.assignee)}
              options={[
                { value: 'none', text: 'Unassigned', display: <TaskAssignee assignee={null} withName size="sm" /> },
                ...assignees.map((option) => ({
                  value: assigneeKey(option.assignee),
                  text: option.assignee.name,
                  display: <TaskAssignee assignee={option.assignee} withName size="sm" />,
                })),
              ]}
              onChange={(value) => {
                const picked = assignees.find((option) => assigneeKey(option.assignee) === value)?.assignee ?? null
                void update({ assignee: assigneeInput(picked) }).catch(() => {})
              }}
            />
          </TaskDetailsField>
          <TaskDetailsField label="Priority">
            <TaskFieldPicker
              label="Priority"
              value={task.priority}
              options={TASK_PRIORITIES.map((priority) => ({
                value: priority,
                text: TASK_PRIORITY_LABELS[priority],
                display: <TaskPriorityIcon priority={priority} withLabel />,
              }))}
              onChange={(priority) => void update({ priority: priority as Priority }).catch(() => {})}
            />
          </TaskDetailsField>
          <TaskDetailsField label="Type">
            <TaskFieldPicker
              label="Type"
              value={task.type}
              options={TASK_TYPES.map((type) => ({ value: type, text: TASK_TYPE_LABELS[type], display: <TaskTypeIcon type={type} withLabel /> }))}
              onChange={(type) => void update({ type: type as TaskType }).catch(() => {})}
            />
          </TaskDetailsField>
          <TaskDetailsField label="Dates">
            <TaskDateRange startDate={task.startDate} endDate={task.endDate} onChange={(range) => void update(range).catch(() => {})} />
          </TaskDetailsField>
          <TaskDetailsField label="Labels">
            <TaskLabelsEditor
              labels={task.labels}
              suggestions={labels}
              onChange={(next) => void update({ labels: next }).catch(() => {})}
              labelMenu={(label) => [
                { id: 'filter', label: 'Show tasks with this label', icon: ListFilter, group: 'open', onSelect: () => navigate(hrefFor(['tasks'], { label })) },
              ]}
            />
          </TaskDetailsField>
          <TaskDetailsField label="Version">
            <TaskFieldPicker
              label="Version"
              value={versionId}
              options={taskVersionOptions(kitVersions, versionId)}
              placeholder="No version"
              onChange={(id) => void update({ version: id ? Number(id) : null }).catch(() => {})}
            />
          </TaskDetailsField>
          <TaskDetailsField label="Parent">
            {task.parentKey ? (
              <ItemContextMenu
                entries={[
                  { id: 'open', label: 'Open', icon: ExternalLink, group: 'open', onSelect: () => openTask(task.parentKey as string) },
                  { id: 'copy-key', label: 'Copy key', icon: Copy, group: 'open', onSelect: () => void copyText(task.parentKey as string, task.parentKey as string) },
                  {
                    id: 'copy-link',
                    label: 'Copy link',
                    icon: Link2,
                    group: 'open',
                    onSelect: () => void copyText(absoluteLink(taskHref(task.parentKey as string)), `link to ${task.parentKey}`),
                  },
                ]}
                render={<a href={linkTo(task.parentKey)} />}
                className="font-mono text-sm text-primary hover:underline"
              >
                {task.parentKey}
              </ItemContextMenu>
            ) : (
              <span className="text-sm text-muted-foreground">None</span>
            )}
          </TaskDetailsField>
          <div className="my-2 border-t" />
          <TaskDetailsField label="Reporter">
            <TaskAssignee assignee={task.reporter} withName size="sm" />
          </TaskDetailsField>
          <TaskDetailsField label="Created">
            <span className="text-sm text-muted-foreground">{formatStamp(task.createdAt)}</span>
          </TaskDetailsField>
          <TaskDetailsField label="Updated">
            <span className="text-sm text-muted-foreground">{formatStamp(task.updatedAt)}</span>
          </TaskDetailsField>
        </>
      }
    >
      <Description
        task={task}
        onSave={(description) => update({ description })}
        renderBody={(body) => <CommentBody body={body} attachment={attachments.attachment} preview={attachments.preview} />}
      />

      <TaskDetailsSection title={attachments.count ? `Attachments (${attachments.count})` : 'Attachments'}>
        <TaskAttachments {...attachments.section} />
      </TaskDetailsSection>

      <div ref={subtaskRef}>
        <TaskDetailsSection title={task.subtasks.length ? `Subtasks (${task.subtasks.length})` : 'Subtasks'}>
          <TaskSubtaskList
            subtasks={task.subtasks}
            onOpen={openTask}
            menuFor={(row) => menuFor(row as TaskSummary)}
            footer={
              <TaskInlineCreate
                key={add === 'subtask' ? 'open' : 'closed'}
                label="Add subtask"
                placeholder="Subtask summary"
                defaultOpen={add === 'subtask'}
                onClose={() => setAdd(null)}
                // A refusal shows in the create row itself.
                onCreate={async (summary) => {
                  await api.task_create({ summary, parent: task.key })
                  await load()
                }}
              />
            }
          />
        </TaskDetailsSection>
      </div>

      <TaskDetailsSection title="Relations">
        <TaskDependencies
          relations={Object.fromEntries(RELATION_GROUPS.map((group) => [group, task[group]]))}
          task={{ key: task.key, startDate: task.startDate, endDate: task.endDate }}
          onOpen={openTask}
          onAdd={async (relation, key) => {
            try {
              await api.task_link(relationInput(relation, task.key, key))
              // The answer is the relation's `to` task, which may be the other one: reload this task.
              await load()
            } catch (error) {
              throw new Error(errorMessage(error))
            }
          }}
          onRemove={async (relation, key) => {
            try {
              await api.task_unlink(relationInput(relation, task.key, key))
              await load()
            } catch (error) {
              throw new Error(errorMessage(error))
            }
          }}
          candidates={candidates}
          rowMenu={(relation, item) => dependencyMenu(relation, item as TaskSummary)}
        />
      </TaskDetailsSection>

      <PullRequests task={task} />

      <WorkflowPanel instanceId={instanceId} task={task} />

      <MentionSessions api={api} instanceId={instanceId} taskKey={task.key} />

      <section ref={commentsRef} className="flex flex-col gap-3">
        <div className="flex items-center gap-1 border-b" role="tablist">
          {(['comments', 'activity'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
                tab === id ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {id === 'comments' ? `Comments${task.comments.length ? ` (${task.comments.length})` : ''}` : 'History'}
            </button>
          ))}
        </div>
        {tab === 'comments' ? (
          <TaskComments
            comments={task.comments}
            renderBody={(body) => <CommentBody body={body} attachment={attachments.attachment} preview={attachments.preview} />}
            onPasteImage={attachments.pasteImage}
            // A refusal shows beside the Comment button.
            onPost={async (body) => {
              await api.task_comment({ key: task.key, body })
              await load()
            }}
            commentMenu={(comment) => commentMenu(comment.id)}
            editingId={editingComment}
            onEditCancel={() => setEditingComment(null)}
            // A refusal shows beside the Save button, and the text stays.
            onEditSave={async (comment, body) => {
              await api.task_comment_update({ key: task.key, id: Number(comment.id), body })
              setEditingComment(null)
              await load()
            }}
            highlightId={linkedComment}
          />
        ) : (
          <TaskActivity
            entries={task.activity}
            rowMenu={(_entry, line) => [
              { id: 'copy', label: 'Copy', icon: Copy, group: 'open', onSelect: () => void copyText(line, 'the line') },
              { id: 'copy-link', label: 'Copy link to task', icon: Link2, group: 'open', onSelect: () => void copyText(absoluteLink(taskHref(task.key)), `link to ${task.key}`) },
            ]}
          />
        )}
      </section>
    </TaskDetailsLayout>
  )

  // A file dropped, or an image pasted, anywhere on the task lands in its Attachments section.
  return <TaskAttachmentDropZone label={task.key}>{details}</TaskAttachmentDropZone>
}
