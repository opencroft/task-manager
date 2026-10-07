// The workflow panel on a task's page. The kit's WorkflowRunPanel draws it;
// this file loads the task's run, performs the actions it reports, and opens
// a step's session in the project chat's dock beside the pages.

import { Markdown, legacy } from '@opencroft/client'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { WorkflowApprovalBar } from '@/components/ui/workflows/workflow-approval-bar'
import { WorkflowRunPanel, type WorkflowRunPanelBusy } from '@/components/ui/workflows/workflow-run-panel'

import type { Task } from '../../shared/types'
import type { ApprovalVerdict, RunStep, WorkflowDef } from '../../shared/workflows'
import { useProject } from '../app/project'
import { useChatDock } from '../chat/project-chat'
import { errorMessage } from '../lib/api'
import { useTasksLive } from '../lib/live'
import { hrefFor } from '../lib/router'
import { type RunView, threadHref, workflowsApi } from './api'

export interface WorkflowPanelProps {
  instanceId: string
  task: Task
}

export function WorkflowPanel({ instanceId, task }: WorkflowPanelProps) {
  const { fail, confirm } = useProject()
  const api = useMemo(() => workflowsApi(instanceId), [instanceId])
  const [view, setView] = useState<RunView | null>(null)
  const [workflows, setWorkflows] = useState<WorkflowDef[] | null>(null)
  const [busy, setBusy] = useState<WorkflowRunPanelBusy>(null)
  const [deciding, setDeciding] = useState<ApprovalVerdict | null>(null)
  const dock = useChatDock()

  const load = useCallback(async () => {
    try {
      const [nextView, list] = await Promise.all([api.workflow_run_get({ task: task.key }), api.workflows_list({})])
      setView(nextView)
      setWorkflows(list.workflows)
    } catch (error) {
      fail(error)
    }
  }, [api, fail, task.key])

  useEffect(() => {
    void load()
  }, [load])

  useTasksLive(instanceId, (events) => {
    if (events.some((event) => event.keys.length === 0 || event.keys.includes(task.key))) {
      void load()
    }
  })

  const act = async (label: Exclude<WorkflowRunPanelBusy, null>, action: () => Promise<unknown>, done: string) => {
    setBusy(label)
    try {
      await action()
      legacy.toast.success(done)
      await load()
    } catch (error) {
      legacy.toast.error(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const decide = async (verdict: ApprovalVerdict, transition: string, comment: string) => {
    setDeciding(verdict)
    try {
      await api.workflow_step_decide({ task: task.key, verdict, transition, ...(comment ? { comment } : {}) })
      legacy.toast.success(verdict === 'approve' ? `Approved ${task.key}` : `Rejected ${task.key}`)
      await load()
    } catch (error) {
      legacy.toast.error(errorMessage(error))
    } finally {
      setDeciding(null)
    }
  }

  // The active run, else the latest one that ended: a finished run's steps and
  // sessions stay readable on the task, and it can be run again from here.
  const run = view?.run ?? view?.history[0] ?? null
  const history = view?.history.filter((r) => r.id !== run?.id) ?? []
  const approval = view?.run ? view.openStep?.approval : undefined

  return (
    <WorkflowRunPanel
      run={run}
      history={history}
      spent={view?.spent}
      workflows={workflows ?? []}
      loading={!view || !workflows}
      // An approval step is decided by its approvers in the approval bar, not advanced.
      openTransitions={view?.run && !approval ? (view.openStep?.transitions ?? []) : []}
      approval={
        approval && view?.openStep ? (
          <WorkflowApprovalBar
            stepName={view.openStep.name}
            needed={approval.needed}
            approvers={approval.approvers}
            transitions={approval.transitions}
            canDecide={approval.canDecide}
            viewerId={approval.viewerId}
            busy={deciding}
            onDecide={(verdict, transition, comment) => void decide(verdict, transition, comment)}
          />
        ) : undefined
      }
      busy={busy}
      onStart={(workflowId) =>
        act('start', () => api.workflow_start({ task: task.key, workflow: workflowId }), `Started the workflow on ${task.key}`)
      }
      onCancel={() =>
        confirm({
          title: `Cancel the workflow on ${task.key}?`,
          description: 'The open step’s session is told to stop. The task keeps its status and its run history.',
          action: 'Cancel run',
          destructive: true,
          onConfirm: () => act('cancel', () => api.workflow_run_cancel({ task: task.key }), `Cancelled the workflow on ${task.key}`),
        })
      }
      onRestart={(step) =>
        act('restart', () => api.workflow_step_restart({ task: task.key, step: step.stepId }), `Restarted ${step.name}`)
      }
      onFinish={(transition) =>
        act('finish', () => api.workflow_step_finish({ task: task.key, transition }), `${task.key} moved to ${transition}`)
      }
      sessionHref={(step) => (step.threadId && step.chatRef ? threadHref(step.chatRef, step.threadId) : null)}
      onOpenSession={dock ? (step) => openStepSession(dock, step) : undefined}
      renderSummary={(summary) => <Markdown text={summary} />}
      createWorkflowHref={hrefFor(['workflows'])}
    />
  )
}

// In the dock when the step's thread is in the dock's chat; a step whose
// session lives in another chat opens on that chat's thread page instead.
function openStepSession(dock: legacy.ChatDockControl, step: RunStep) {
  if (!step.threadId || !step.chatSlug) {
    return
  }
  if (step.chatSlug === dock.space) {
    dock.openThread(step.threadId)
  } else {
    window.open(threadHref(step.chatRef ?? step.chatSlug, step.threadId), '_blank')
  }
}
