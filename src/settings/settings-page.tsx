// The project's settings, one section at a time: `/settings/<section>`, so a
// section can be linked to and survives a reload. Each section edits through
// the same actions an agent calls.

import {
  Download,
  FolderKanban,
  GitPullRequest,
  ListChecks,
  MessagesSquare,
  Milestone,
  Tag,
  Workflow,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { SettingsLayout, SettingsSection } from '@/components/ui/settings/settings-layout'
import { TaskForgeConnection } from '@/components/ui/tasks/task-forge-connection'
import { TaskLabelsManager } from '@/components/ui/tasks/task-labels-manager'
import {
  type OpenProjectImportMapping,
  type OpenProjectImportPreview,
  type OpenProjectTargetPerson,
  TaskOpenProjectImport,
} from '@/components/ui/tasks/task-openproject-import'
import { type TaskVersionInput, TaskVersionsManager } from '@/components/ui/tasks/task-versions-manager'
import { FORGE_POLL_SECONDS, FORGE_SECRET_PREFIX, type ForgeStatus } from '../../shared/forge'
import {
  isImportResult,
  isPreview,
  isSyncMinutes,
  OPENPROJECT_DEFAULT_SECRET_KEY,
  OPENPROJECT_SECRET_PREFIX,
  OPENPROJECT_SYNC_MINUTES,
  type OpenProjectImportState,
  type OpenProjectMapping,
  type OpenProjectPreview,
} from '../../shared/openproject'
import type { ProjectInfo } from '../../shared/settings'
import type { WorkflowDef } from '../../shared/workflows'
import { useProject } from '../app/project'
import { errorMessage } from '../lib/api'
import { useTasksLive } from '../lib/live'
import { hrefFor } from '../lib/router'
import { toTaskVersion } from '../lib/versions'
import { workflowsApi } from '../workflows/api'
import { SpaceChatStatus } from './space-chat-status'
import { StatusesEditor } from './statuses-editor'

export const SETTINGS_ROUTE = 'settings'

const SECTIONS = [
  { id: 'project', label: 'Project', icon: FolderKanban },
  { id: 'statuses', label: 'Statuses', icon: ListChecks },
  { id: 'labels', label: 'Labels', icon: Tag },
  { id: 'versions', label: 'Versions', icon: Milestone },
  { id: 'workflows', label: 'Workflows', icon: Workflow },
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
  { id: 'pull-requests', label: 'Pull requests', icon: GitPullRequest },
  { id: 'import', label: 'Import', icon: Download },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export const settingsHref = (section?: SectionId) => hrefFor(section ? [SETTINGS_ROUTE, section] : [SETTINGS_ROUTE])

/** Rethrow an action's failure with only its message, for a component that shows it in place. */
function plain(error: unknown): never {
  throw new Error(errorMessage(error))
}

function ProjectSection() {
  const { api, projectKey } = useProject()
  const [info, setInfo] = useState<ProjectInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.project_info({}).then(setInfo, (failure) => setError(errorMessage(failure)))
  }, [api])
  return (
    <SettingsSection
      title='Project'
      description='What this project is called, and the key its tasks are numbered with.'
    >
      <dl className='grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[8rem_1fr]'>
        <dt className='text-muted-foreground'>Name</dt>
        <dd className='min-w-0'>
          <div className='truncate font-medium'>{info?.name ?? (error ? '—' : '…')}</div>
          <p className='text-xs text-muted-foreground'>
            It is the App's name: rename it where the space's apps are edited.
          </p>
        </dd>
        <dt className='text-muted-foreground'>Key</dt>
        <dd className='min-w-0'>
          <div className='font-mono font-medium'>{info?.key ?? projectKey}</div>
          <p className='text-xs text-muted-foreground'>
            Every task key starts with it ({projectKey}-1, {projectKey}-2…), so it does not change here.
          </p>
        </dd>
      </dl>
      {error ? <p className='text-sm text-destructive'>{error}</p> : null}
    </SettingsSection>
  )
}

function LabelsSection() {
  const { api, projectLabels, labelsLoaded } = useProject()
  return (
    <SettingsSection
      title='Labels'
      description='Every label in use, with how many tasks carry it. A rename, merge or delete changes every task that has the label, and the saved views that filter by it.'
    >
      <TaskLabelsManager
        labels={projectLabels}
        loading={!labelsLoaded}
        onRename={(name, next) => api.label_rename({ label: name, to: next }).then(() => undefined, plain)}
        onColorChange={(name, color) => api.label_color({ label: name, color }).then(() => undefined, plain)}
        onMerge={(from, into) => api.label_merge({ label: from, into }).then(() => undefined, plain)}
        onDelete={(name) => api.label_delete({ label: name }).then(() => undefined, plain)}
      />
    </SettingsSection>
  )
}

function VersionsSection() {
  const { api, versions, labelsLoaded } = useProject()
  const kitVersions = useMemo(() => versions.map(toTaskVersion), [versions])
  const input = (next: TaskVersionInput) => ({
    name: next.name,
    targetDate: next.targetDate,
    description: next.description ?? '',
  })
  return (
    <SettingsSection
      title='Versions'
      description='The releases tasks are planned into, named by semantic version (1.4.0, 2.0.0-beta.1). Releasing one dates it and can move what is still open to the next.'
    >
      <TaskVersionsManager
        versions={kitVersions}
        loading={!labelsLoaded}
        onCreate={(next) => api.version_create(input(next)).then(() => undefined, plain)}
        onUpdate={(id, next) =>
          api.version_update({ version: Number(id), ...input(next) }).then(() => undefined, plain)
        }
        onRelease={(id, { moveOpenTo }) =>
          api
            .version_release({ version: Number(id), ...(moveOpenTo ? { moveOpenTo: Number(moveOpenTo) } : {}) })
            .then(() => undefined, plain)
        }
        onArchive={(id) => api.version_update({ version: Number(id), state: 'archived' }).then(() => undefined, plain)}
        onRestore={(id) => api.version_update({ version: Number(id), state: 'planned' }).then(() => undefined, plain)}
        loadOpenTasks={async (id) => {
          const { tasks } = await api.task_list({ version: [id], statusCategory: ['todo', 'in_progress'], limit: 1000 })
          return tasks.map((task) => ({ key: task.key, summary: task.summary }))
        }}
      />
    </SettingsSection>
  )
}

function WorkflowsSection() {
  const { instanceId, fail } = useProject()
  const workflows = useMemo(() => workflowsApi(instanceId), [instanceId])
  const [list, setList] = useState<WorkflowDef[] | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setList((await workflows.workflows_list({})).workflows)
    } catch (failure) {
      fail(failure)
    }
  }, [workflows, fail])

  useEffect(() => {
    void load()
  }, [load])

  useTasksLive(instanceId, (events) => {
    if (events.some((event) => event.kind === 'workflow')) {
      void load()
    }
  })

  const makeDefault = async (wf: WorkflowDef) => {
    setBusy(true)
    try {
      await workflows.workflow_save({ workflow: { ...wf, isDefault: true } })
      await load()
    } catch (failure) {
      fail(failure)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      title='Workflows'
      description='The default workflow is the one a task starts when none is named.'
      actions={
        <a
          href={hrefFor(['workflows'])}
          className='text-sm font-medium text-primary underline-offset-4 hover:underline'
        >
          Open Workflows
        </a>
      }
    >
      {list === null ? <p className='text-sm text-muted-foreground'>Loading workflows…</p> : null}
      {list?.length === 0 ? (
        <p className='text-sm text-muted-foreground'>
          No workflows yet.{' '}
          <a href={hrefFor(['workflows'])} className='font-medium text-primary underline-offset-4 hover:underline'>
            Create one
          </a>{' '}
          on the Workflows page.
        </p>
      ) : null}
      {list?.length ? (
        <fieldset className='flex flex-col gap-1' disabled={busy}>
          <legend className='sr-only'>Default workflow</legend>
          {list.map((wf) => (
            <label
              key={wf.id}
              className='flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 has-[:checked]:border-primary'
            >
              <input
                type='radio'
                name='default-workflow'
                checked={wf.isDefault}
                onChange={() => void makeDefault(wf)}
                className='accent-primary'
              />
              <span className='min-w-0 flex-1'>
                <span className='block truncate text-sm font-medium'>{wf.name}</span>
                <span className='block truncate text-xs text-muted-foreground'>
                  {wf.steps.length} {wf.steps.length === 1 ? 'step' : 'steps'}
                  {wf.description ? ` · ${wf.description}` : ''}
                </span>
              </span>
              {wf.isDefault ? <span className='text-xs font-medium text-primary'>Default</span> : null}
            </label>
          ))}
        </fieldset>
      ) : null}
    </SettingsSection>
  )
}

// The kit names our statuses by string id; the actions by number.
const toKitMapping = (mapping: OpenProjectMapping): OpenProjectImportMapping => ({
  ...mapping,
  statuses: Object.fromEntries(
    Object.entries(mapping.statuses).map(([id, target]) => [
      id,
      'status' in target ? { status: String(target.status) } : target,
    ]),
  ),
})
const fromKitMapping = (mapping: OpenProjectImportMapping): OpenProjectMapping => ({
  ...mapping,
  statuses: Object.fromEntries(
    Object.entries(mapping.statuses).map(([id, target]) => [
      id,
      'status' in target ? { status: Number(target.status) } : target,
    ]),
  ),
})
const toKitPreview = (preview: OpenProjectPreview): OpenProjectImportPreview => ({
  ...preview,
  mapping: toKitMapping(preview.mapping),
})

function PullRequestsSection() {
  const { api, instanceId } = useProject()
  const [status, setStatus] = useState<ForgeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(
    () =>
      api.forge_status({}).then(
        (next) => {
          setStatus(next)
          setError(null)
        },
        (failure) => setError(errorMessage(failure)),
      ),
    [api],
  )
  useEffect(() => {
    void load()
  }, [load])
  // The server announces the first read when it finishes, and every read that changes a link.
  useTasksLive(instanceId, () => void load())
  return (
    <SettingsSection
      title='Pull requests'
      description="Pull requests on the forge that name a task's key in their title, description or branch show on that task with their state. The server reads the forge every minute; nothing is linked by hand."
    >
      <TaskForgeConnection
        status={status}
        error={error}
        onRetry={() => void load()}
        onConnect={(value) => api.forge_connect(value).then(setStatus, plain)}
        onDisconnect={() => api.forge_disconnect({}).then(setStatus, plain)}
        defaults={{ secretKey: `${FORGE_SECRET_PREFIX}TASKS_TOKEN` }}
        secretKeyPrefix={FORGE_SECRET_PREFIX}
        pollSeconds={FORGE_POLL_SECONDS}
      />
    </SettingsSection>
  )
}

function ImportSection() {
  const { api, instanceId, statuses, assignees } = useProject()
  const [state, setState] = useState<OpenProjectImportState | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    api.import_openproject_state({}).then(setState, (failure) => setError(errorMessage(failure)))
  }, [api])
  useEffect(load, [load])
  // A scheduled import that changed tasks announces it; its result is then the last import.
  useTasksLive(instanceId, load)

  const kitStatuses = useMemo(
    () => statuses.map((status) => ({ id: String(status.id), name: status.name, category: status.category })),
    [statuses],
  )
  // Only someone with an id can be chosen; a name alone is what "Keep the name only" gives.
  const kitAssignees = useMemo(
    () =>
      assignees.flatMap(({ assignee }): OpenProjectTargetPerson[] =>
        assignee.id ? [{ kind: assignee.kind, id: assignee.id, name: assignee.name }] : [],
      ),
    [assignees],
  )

  return (
    <SettingsSection
      title='Import'
      description='Bring a project in from OpenProject: its work packages become tasks, with their parents, descriptions, dates, comments, relations and attachments. Importing again updates what changed there, keeps what was changed here, and never adds anything twice, nor anything removed here.'
    >
      <TaskOpenProjectImport
        connection={state?.connection ?? null}
        lastImport={state?.lastImport ?? null}
        sync={state?.sync}
        syncChoices={OPENPROJECT_SYNC_MINUTES}
        onSyncChange={(minutes) =>
          minutes === null || isSyncMinutes(minutes)
            ? api.import_openproject_sync({ minutes }).then(setState, plain)
            : Promise.reject(new Error(`The import can't run every ${minutes} minutes.`))
        }
        defaultSecretKey={OPENPROJECT_DEFAULT_SECRET_KEY}
        secretKeyPrefix={OPENPROJECT_SECRET_PREFIX}
        statuses={kitStatuses}
        assignees={kitAssignees}
        loading={state === null && error === null}
        error={error}
        onRetry={load}
        onPreview={async (connection) => {
          const result = await api.import_openproject({ ...connection }).catch(plain)
          if (!isPreview(result)) {
            throw new Error('Expected a preview')
          }
          return toKitPreview(result)
        }}
        onImport={async ({ connection, mapping, keepNumbers, overwrite }) => {
          const result = await api
            .import_openproject({
              ...connection,
              mapping: fromKitMapping(mapping),
              keepNumbers,
              overwrite,
              confirm: true,
            })
            .catch(plain)
          if (!isImportResult(result)) {
            throw new Error('Expected an import result')
          }
          load()
          return result
        }}
      />
    </SettingsSection>
  )
}

export function SettingsPage({ section }: { section?: string }) {
  const active: SectionId = SECTIONS.some((candidate) => candidate.id === section) ? (section as SectionId) : 'project'
  return (
    <SettingsLayout
      title='Settings'
      sections={SECTIONS.map(({ id, label, icon }) => ({ id, label, icon }))}
      active={active}
      hrefFor={(id) => settingsHref(id as SectionId)}
    >
      {active === 'project' ? <ProjectSection /> : null}
      {active === 'statuses' ? (
        <SettingsSection
          title='Statuses'
          description='The steps a task moves through, in board order. The category says what a status means (not started, in progress or finished) for filters, progress and workflows.'
        >
          <StatusesEditor />
        </SettingsSection>
      ) : null}
      {active === 'labels' ? <LabelsSection /> : null}
      {active === 'versions' ? <VersionsSection /> : null}
      {active === 'workflows' ? <WorkflowsSection /> : null}
      {active === 'chat' ? (
        <SettingsSection
          title='Chat'
          description="The task manager talks in this space's chat: each workflow step's session, each agent @mentioned in a task's comment, and the project chat beside the pages open their threads there."
        >
          <SpaceChatStatus />
        </SettingsSection>
      ) : null}
      {active === 'pull-requests' ? <PullRequestsSection /> : null}
      {active === 'import' ? <ImportSection /> : null}
    </SettingsLayout>
  )
}
