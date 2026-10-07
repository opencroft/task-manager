// The Workflows page: the project's workflow definitions on the left, the
// chosen one's step editor (or its runs, or its statistics) on the right. The
// selection and the tab live in the URL, so each of them is a link.

import { legacy } from '@opencroft/client'
import { cn } from 'cn'
import { Info, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { TaskManagerEmpty } from '@/components/ui/states/task-manager-empty'
import { TaskManagerError } from '@/components/ui/states/task-manager-error'
import { TaskManagerSkeleton } from '@/components/ui/states/task-manager-skeleton'
import { TaskStatusBadge } from '@/components/ui/tasks/task-status-badge'
import { Textarea } from '@/components/ui/textarea'
import { WorkflowList } from '@/components/ui/workflows/workflow-list'
import { WorkflowStepCard, type WorkflowStepCardValue } from '@/components/ui/workflows/workflow-step-card'
import { WorkflowStepList } from '@/components/ui/workflows/workflow-step-list'

import type { Status } from '../../shared/types'
import {
  DEFAULT_COMPACT_ABOVE,
  DEFAULT_STEP_INSTRUCTIONS,
  derivedGate,
  STEP_EFFORTS,
  STEP_PERMISSION_MODES,
  type SpaceChatState,
  type StepEffort,
  type StepPermissionMode,
  type StepSessionOptions,
  type ValidationIssue,
  type WorkflowDef,
  type WorkflowDraft,
} from '../../shared/workflows'
import { useProject } from '../app/project'
import { PageSidebarSection } from '../app/sidebar-section'
import { errorMessage } from '../lib/api'
import { useTasksLive } from '../lib/live'
import { navigateQuery, useQueryParam } from '../lib/router'
import { settingsHref } from '../settings/settings-page'
import { workflowsApi } from './api'
import { copySteps, type DraftStep, type DraftTransition, draftTransition, duplicateStep, newStepId, nextKey, noApproval } from './draft-steps'
import { runsMatchParams } from './runs-match'
import { WorkflowRunsView } from './runs-view'
import { WorkflowStatsView } from './stats-view'

const TAB_LABELS = { steps: 'Steps', runs: 'Runs', stats: 'Stats' } as const

interface Draft {
  id?: string
  name: string
  description: string
  isDefault: boolean
  steps: DraftStep[]
}

const TASK_PLACEHOLDERS = [
  { token: 'task.key', label: 'Task key' },
  { token: 'task.summary', label: 'Summary' },
  { token: 'task.description', label: 'Description' },
  { token: 'task.status', label: 'Status' },
  { token: 'task.type', label: 'Type' },
  { token: 'task.priority', label: 'Priority' },
  { token: 'task.assignee', label: 'Assignee' },
  { token: 'step.name', label: 'This step' },
  { token: 'workflow.name', label: 'Workflow' },
]

function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function toDraft(wf: WorkflowDef): Draft {
  return {
    id: wf.id,
    name: wf.name,
    description: wf.description,
    isDefault: wf.isDefault,
    steps: wf.steps.map((s) => ({ ...s, approval: s.approval ?? noApproval(), key: nextKey(), transitions: s.transitions.map(draftTransition) })),
  }
}

// The card carries effort and mode as plain strings, since it knows no vocabulary of its own beyond what it
// offers; the payload takes the shared vocabulary, so a string is narrowed to it here rather than cast.
function isEffort(value: string): value is StepEffort {
  return (STEP_EFFORTS as readonly string[]).includes(value)
}

function isPermissionMode(value: string): value is StepPermissionMode {
  return (STEP_PERMISSION_MODES as readonly string[]).includes(value)
}

function toSessionOptions(options: WorkflowStepCardValue['sessionOptions']): StepSessionOptions {
  const out: StepSessionOptions = {}
  if (options.effort !== undefined && isEffort(options.effort)) {
    out.effort = options.effort
  }
  if (options.presence) {
    out.presence = options.presence
  }
  if (options.permissionMode !== undefined && isPermissionMode(options.permissionMode)) {
    out.permissionMode = options.permissionMode
  }
  // Passed as typed, an invalid count included: validation names what is wrong with it.
  if (options.compactAbove !== undefined) {
    out.compactAbove = options.compactAbove
  }
  return out
}

function toPayload(draft: Draft): WorkflowDraft {
  return {
    id: draft.id,
    name: draft.name,
    description: draft.description,
    isDefault: draft.isDefault,
    steps: draft.steps.map(({ key: _key, triggerStatus, sessionOptions, transitions, approval, ...step }) => ({
      ...step,
      // An agent step keeps its approvers only in the editor, for switching back.
      approval: step.kind === 'approval' ? approval : null,
      triggerStatus: triggerStatus ?? 0,
      transitions: transitions.map(({ key: _tkey, status, ...t }) => ({ ...t, status: status ?? 0 })),
      sessionOptions: toSessionOptions(sessionOptions),
    })),
  }
}

/** A starting point shaped by the project's statuses: work, then review, then done. */
function templateDraft(statuses: Status[], taken: string[]): Draft {
  const working = statuses.filter((s) => s.category === 'in_progress')
  const done = statuses.find((s) => s.category === 'done')
  const dev = working[0]
  const review = working[1]
  let name = 'Development'
  for (let n = 2; taken.some((t) => t.toLowerCase() === name.toLowerCase()); n += 1) {
    name = `Development ${n}`
  }
  const devStep = dev ? templateStep('Development', dev, 'Implement {{ task.key }}: {{ task.summary }}.\n\n{{ task.description }}') : null
  const reviewStep = review
    ? templateStep('Review', review, 'Review the work on {{ task.key }}: {{ task.summary }}. The developer reported:\n\n{{ steps.development.summary }}')
    : null
  if (devStep) {
    devStep.transitions = edges(reviewStep ? ['Ready for review', reviewStep, review] : ['Done', null, done])
  }
  if (reviewStep) {
    reviewStep.transitions = edges(['Approved', null, done], ['Changes requested', devStep, dev])
  }
  return { name, description: '', isDefault: false, steps: [devStep, reviewStep].filter((s): s is DraftStep => s !== null) }
}

function templateStep(name: string, status: Status | undefined, instructions: string): DraftStep {
  return {
    id: newStepId(),
    key: nextKey(),
    name,
    kind: 'agent',
    approval: noApproval(),
    triggerStatus: status?.id ?? null,
    worker: { kind: 'assignee' },
    instructions,
    transitions: [],
    folder: '',
    sessionOptions: {},
  }
}

/** A template's transitions, each `[label, the step it opens (null: the end), the status it sets]`; one without its status is left out. */
function edges(...list: Array<[string, DraftStep | null, Status | undefined]>): DraftTransition[] {
  return list.flatMap(([label, to, status]) =>
    status ? [draftTransition({ label, toStep: to?.id ?? null, status: status.id, gate: null })] : [],
  )
}

/**
 * The one-press starting workflow the empty page offers: Development, Review,
 * QA, each on its own working status. A project without a third working
 * status for QA gets one ("In QA", before the first finished status) — the
 * template promises three steps, and a step needs a status of its own.
 */
function qaTemplate(statuses: Status[]): Draft {
  const [dev, review, qa] = statuses.filter((s) => s.category === 'in_progress')
  const done = statuses.find((s) => s.category === 'done')
  const devStep = templateStep('Development', dev, 'Implement {{ task.key }}: {{ task.summary }}.\n\n{{ task.description }}')
  const reviewStep = templateStep('Review', review, 'Review the work on {{ task.key }}: {{ task.summary }}. The developer reported:\n\n{{ steps.development.summary }}')
  const qaStep = templateStep('QA', qa, 'Test {{ task.key }}: {{ task.summary }} as a user would. The review said:\n\n{{ steps.review.summary }}')
  devStep.transitions = edges(['Ready for review', reviewStep, review])
  reviewStep.transitions = edges(['Approved', qaStep, qa], ['Changes requested', devStep, dev])
  qaStep.transitions = edges(['Passed', null, done], ['Failed', devStep, dev])
  return {
    name: 'Development, Review, QA',
    description: 'Work the task, review it, then test it. Review and QA can send it back to Development.',
    isDefault: false,
    steps: [devStep, reviewStep, qaStep],
  }
}

/** Issues grouped by where they belong: the workflow's own fields, and each step's by field. */
function groupIssues(issues: ValidationIssue[]) {
  const top: Record<string, string[]> = {}
  const steps: Array<Record<string, string[]>> = []
  for (const issue of issues) {
    // A session setting's field keeps its own name (`sessionOptions.effort`), which the card shows under one field.
    // A transition's keeps its index and field too (`transitions.1.label`), which the card shows under that transition.
    const match = /^steps\.(\d+)(?:\.([a-zA-Z]+(?:\.(?:[a-zA-Z]+|\d+))*))?/.exec(issue.path)
    if (match) {
      const index = Number(match[1])
      const field = match[2] ?? 'name'
      const forStep = steps[index] ?? {}
      steps[index] = forStep
      forStep[field] = [...(forStep[field] ?? []), issue.message]
    } else {
      top[issue.path] = [...(top[issue.path] ?? []), issue.message]
    }
  }
  return { top, steps }
}

export function WorkflowsPage() {
  const { instanceId, statuses, assignees, fail, confirm, api: tasks } = useProject()
  const api = useMemo(() => workflowsApi(instanceId), [instanceId])
  const [selectedId, setSelectedId] = useQueryParam('w')
  const [tab] = useQueryParam('tab')
  // Another tab or workflow leaves the runs a statistic counted behind: its step belongs to this workflow's Runs tab.
  const openTab = (id: keyof typeof TAB_LABELS) => navigateQuery({ tab: id === 'steps' ? null : id, ...runsMatchParams(null) }, { replace: true })
  const selectWorkflow = (id: string) => navigateQuery({ w: id, ...runsMatchParams(null) }, { replace: true })
  const [workflows, setWorkflows] = useState<WorkflowDef[] | null>(null)
  // The space's chat, where every step's session opens: its agents are the ones a step can be given to.
  const [spaceChat, setSpaceChat] = useState<SpaceChatState | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [templating, setTemplating] = useState(false)

  const load = useCallback(async () => {
    try {
      const [list, chat] = await Promise.all([api.workflows_list({}), api.space_chat({})])
      setWorkflows(list.workflows)
      setSpaceChat(chat)
      setLoadError(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  useTasksLive(instanceId, (events) => {
    if (events.some((e) => e.kind === 'workflow' || e.kind === 'status')) {
      void load()
    }
  })

  const creating = selectedId === 'new'
  const selected = workflows?.find((w) => w.id === selectedId) ?? null

  // Follow the selection; never overwrite unsaved edits with a refetch.
  const loadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!workflows) {
      return
    }
    if (!selectedId && workflows[0]) {
      setSelectedId(workflows[0].id)
      return
    }
    const target = creating ? 'new' : (selected?.id ?? null)
    if (loadedFor.current === target && dirty) {
      return
    }
    if (loadedFor.current !== target || !dirty) {
      loadedFor.current = target
      setDraft(
        creating
          ? templateDraft(
              statuses,
              workflows.map((w) => w.name),
            )
          : selected
            ? toDraft(selected)
            : null,
      )
      setDirty(creating)
      setIssues([])
    }
  }, [workflows, selectedId, selected, creating, statuses, dirty, setSelectedId])

  // Validate as the person edits, through the same check a save runs.
  useEffect(() => {
    if (!draft || !dirty) {
      return
    }
    const timer = setTimeout(() => {
      api
        .workflow_validate({ workflow: toPayload(draft) })
        .then((result) => setIssues(result.issues))
        .catch(() => {})
    }, 350)
    return () => clearTimeout(timer)
  }, [api, draft, dirty])

  const edit = (patch: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
    setDirty(true)
  }
  const editStep = (index: number, value: WorkflowStepCardValue) =>
    edit({ steps: draft?.steps.map((s, i) => (i === index ? { ...s, ...value } : s)) ?? [] })

  const reorderStep = (from: number, to: number) => {
    if (!draft || to < 0 || to >= draft.steps.length) {
      return
    }
    const steps = [...draft.steps]
    const [step] = steps.splice(from, 1)
    if (step) {
      steps.splice(to, 0, step)
      edit({ steps })
    }
  }

  const save = async () => {
    if (!draft) {
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await api.workflow_save({ workflow: toPayload(draft) })
      legacy.toast.success(`Saved ${saved.name}`)
      setDirty(false)
      loadedFor.current = null
      setSelectedId(saved.id)
      await load()
    } catch (error) {
      setSaveError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const createFromTemplate = async () => {
    setTemplating(true)
    setSaveError(null)
    try {
      let current = await tasks.status_list({})
      if (current.filter((s) => s.category === 'in_progress').length < 3) {
        await tasks.status_create({ name: 'In QA', category: 'in_progress' })
        current = await tasks.status_list({})
        const qa = current.find((s) => s.name === 'In QA')
        const firstDone = current.findIndex((s) => s.category === 'done')
        if (qa && firstDone >= 0) {
          const order = current.filter((s) => s.id !== qa.id).map((s) => s.id)
          order.splice(firstDone, 0, qa.id)
          await tasks.status_reorder({ order })
          current = await tasks.status_list({})
        }
        legacy.toast.success('Added the status "In QA" for the QA step')
      }
      const saved = await api.workflow_save({ workflow: toPayload(qaTemplate(current)) })
      legacy.toast.success(`Created ${saved.name}`)
      loadedFor.current = null
      setSelectedId(saved.id)
      await load()
    } catch (error) {
      setSaveError(errorMessage(error))
    } finally {
      setTemplating(false)
    }
  }

  const discard = () => {
    setDirty(false)
    setSaveError(null)
    loadedFor.current = null
    if (creating) {
      setSelectedId(workflows?.[0]?.id ?? null)
    } else if (selected) {
      setDraft(toDraft(selected))
      setIssues([])
    }
  }

  const remove = (wf: WorkflowDef) =>
    confirm({
      title: `Delete ${wf.name}?`,
      description: 'Tasks that ran it keep their run history. A workflow a task is running now cannot be deleted; cancel that run first.',
      action: 'Delete',
      destructive: true,
      onConfirm: async () => {
        await api.workflow_delete({ workflow: wf.id })
        legacy.toast.success(`Deleted ${wf.name}`)
        if (selectedId === wf.id) {
          setSelectedId(null)
        }
        await load()
      },
    })

  const makeDefault = async (wf: WorkflowDef) => {
    try {
      await api.workflow_save({ workflow: { ...wf, isDefault: true } })
      await load()
    } catch (error) {
      fail(error)
    }
  }

  const duplicate = (wf: WorkflowDef) => {
    const copy = toDraft(wf)
    let name = `${wf.name} copy`
    for (let n = 2; workflows?.some((w) => w.name.toLowerCase() === name.toLowerCase()); n += 1) {
      name = `${wf.name} copy ${n}`
    }
    loadedFor.current = 'new'
    setSelectedId('new')
    setDraft({ ...copy, id: undefined, name, isDefault: false, steps: copySteps(copy.steps) })
    setDirty(true)
  }

  const statusOptions = useMemo(
    () => statuses.map((s) => ({ id: s.id, name: s.name, display: <TaskStatusBadge name={s.name} category={s.category} color={s.color} size="sm" /> })),
    [statuses],
  )
  // Who can approve: the people of the host's directory, the only ones with an id.
  const people = useMemo(
    () => assignees.flatMap(({ assignee }) => (assignee.kind === 'person' && assignee.id ? [{ id: assignee.id, name: assignee.name }] : [])),
    [assignees],
  )
  const grouped = groupIssues(issues)

  if (!workflows) {
    return loadError ? (
      <TaskManagerError title="Couldn’t load workflows" message={loadError} onRetry={() => void load()} />
    ) : (
      <TaskManagerSkeleton page="workflows" />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      {/* The workflow list is this page's section of the App sidebar. */}
      <PageSidebarSection>
        <WorkflowList
          variant="sidebar"
          workflows={workflows}
          selectedId={selectedId}
          onSelect={selectWorkflow}
          onCreate={() => setSelectedId('new')}
          creatingName={creating ? draft?.name || 'New workflow' : null}
          onMakeDefault={(wf) => void makeDefault(wf)}
          onDuplicate={duplicate}
          onDelete={remove}
        />
      </PageSidebarSection>

      <main className="flex min-w-0 flex-1 flex-col gap-4">
        {saveError ? (
          <TaskManagerError
            variant="inline"
            title={creating || !draft ? 'Couldn’t create the workflow' : 'Couldn’t save the workflow'}
            message={saveError}
            onDismiss={() => setSaveError(null)}
          />
        ) : null}
        {!draft ? (
          <TaskManagerEmpty
            kind="no-workflows"
            busy={templating}
            onUseTemplate={() => void createFromTemplate()}
            onCreateWorkflow={() => setSelectedId('new')}
          />
        ) : (
          <>
            <div className="flex items-center gap-1 border-b" role="tablist">
              {(['steps', 'runs', 'stats'] as const).map((id) => {
                const current = (tab ?? 'steps') === id
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={current}
                    disabled={id !== 'steps' && creating}
                    onClick={() => openTab(id)}
                    className={cn(
                      '-mb-px border-b-2 px-3 py-2 text-sm transition-colors disabled:opacity-40',
                      current ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {TAB_LABELS[id]}
                  </button>
                )
              })}
              {(tab ?? 'steps') === 'steps' ? (
                <div className="ml-auto flex items-center gap-2 pb-1.5">
                  {dirty ? (
                    <Button variant="ghost" size="sm" onClick={discard} disabled={saving}>
                      Discard
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => void save()} disabled={!dirty || saving || issues.length > 0}>
                    {saving ? <Loader2 className="animate-spin" /> : null}
                    {creating ? 'Create workflow' : 'Save'}
                  </Button>
                </div>
              ) : null}
            </div>

            {(tab ?? 'steps') === 'runs' && selected ? (
              <WorkflowRunsView instanceId={instanceId} workflow={selected} />
            ) : (tab ?? 'steps') === 'stats' && selected ? (
              <WorkflowStatsView key={selected.id} instanceId={instanceId} workflow={selected} />
            ) : (
              <div className="flex max-w-4xl flex-col gap-4">
                <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start">
                  <div className="flex flex-col gap-1">
                    <Input
                      value={draft.name}
                      placeholder="Workflow name"
                      aria-label="Workflow name"
                      aria-invalid={grouped.top.name ? true : undefined}
                      onChange={(event) => edit({ name: event.target.value })}
                      className="text-base font-semibold"
                    />
                    {grouped.top.name?.map((m) => (
                      <span key={m} className="text-xs text-destructive">
                        {m}
                      </span>
                    ))}
                  </div>
                  {/* biome-ignore lint/a11y/noLabelWithoutControl: the Base UI Checkbox inside is the control (a button role="checkbox"), and pressing the label toggles it */}
                  <label className="flex h-9 items-center gap-2 text-sm">
                    <Checkbox checked={draft.isDefault} onCheckedChange={(checked) => edit({ isDefault: checked === true })} />
                    Default for new runs
                  </label>
                </div>
                <Textarea
                  value={draft.description}
                  rows={2}
                  placeholder="What is this workflow for? (optional)"
                  aria-label="Description"
                  onChange={(event) => edit({ description: event.target.value })}
                />

                <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    Every step's session opens in this space's chat
                    {spaceChat?.name ? <span className="font-medium text-foreground"> {spaceChat.name}</span> : null}. The agent working a step must
                    be in it; any other one waits with that reason.{' '}
                    {spaceChat && !spaceChat.taskManagerIn ? "The task manager isn't in the chat yet: let it in from Settings → Chat. " : ''}
                    <a href={settingsHref('chat')} className="font-medium text-primary underline-offset-4 hover:underline">
                      Chat settings
                    </a>
                  </span>
                </p>

                {grouped.top.steps?.map((m) => (
                  <span key={m} className="text-sm text-destructive">
                    {m}
                  </span>
                ))}

                <WorkflowStepList
                  items={draft.steps}
                  onReorder={reorderStep}
                  addLabel="Add step"
                  onAdd={() =>
                    edit({
                      steps: [
                        ...draft.steps,
                        {
                          id: newStepId(),
                          key: nextKey(),
                          name: '',
                          kind: 'agent',
                          approval: noApproval(),
                          triggerStatus: null,
                          worker: { kind: 'assignee' },
                          instructions: DEFAULT_STEP_INSTRUCTIONS,
                          transitions: [],
                          folder: '',
                          sessionOptions: {},
                        },
                      ],
                    })
                  }
                  renderStep={(step, index, dragHandle) => {
                    const earlier = draft.steps.slice(0, index).filter((s) => slugOf(s.name))
                    return (
                      <WorkflowStepCard
                        index={index}
                        count={draft.steps.length}
                        value={step}
                        dragHandle={dragHandle}
                        onChange={(value) => editStep(index, value)}
                        statuses={statusOptions}
                        agents={spaceChat?.agents ?? []}
                        chatName={spaceChat?.name ?? undefined}
                        people={people}
                        steps={draft.steps.filter((s) => s.id !== step.id).map((s) => ({ id: s.id, name: s.name }))}
                        derivedGate={(toStep) => derivedGate(draft.steps, step.id, toStep)}
                        issues={grouped.steps[index]}
                        placeholders={[
                          ...TASK_PLACEHOLDERS,
                          ...earlier.flatMap((s) => [
                            { token: `steps.${slugOf(s.name)}.summary`, label: `${s.name}: summary` },
                            { token: `steps.${slugOf(s.name)}.outcome`, label: `${s.name}: outcome` },
                          ]),
                        ]}
                        defaultCompactAbove={DEFAULT_COMPACT_ABOVE}
                        onMove={(direction) => reorderStep(index, index + direction)}
                        onDuplicate={() => edit({ steps: duplicateStep(draft.steps, index) })}
                        onDelete={() => edit({ steps: draft.steps.filter((_, i) => i !== index) })}
                      />
                    )
                  }}
                />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
