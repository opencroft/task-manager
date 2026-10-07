import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { WorkflowDraft } from '../../shared/workflows.ts'
import { normalizeDraft, type ValidationEnv, validateWorkflow } from './definition.ts'

let n = 0
const mint = () => `id-${++n}`

const statuses = [
  { id: 1, name: 'To do' },
  { id: 2, name: 'In progress' },
  { id: 3, name: 'Review' },
  { id: 4, name: 'Done' },
]
const people = [
  { id: 'person-alice', name: 'Alice' },
  { id: 'person-bob', name: 'Bob' },
  { id: 'person-carol', name: 'Carol' },
]
const env: ValidationEnv = { statuses, otherNames: ['Hotfix'], people }

function draft(overrides: Partial<WorkflowDraft> = {}): WorkflowDraft {
  return {
    name: ' Standard ',
    steps: [
      {
        name: 'Development',
        triggerStatus: 2,
        worker: { kind: 'assignee' },
        instructions: 'Work on {{ task.key }}.',
        transitions: [3, 3],
      },
      {
        name: 'Review',
        triggerStatus: 3,
        worker: { kind: 'agent', agentNodeId: 'agent_rev' },
        instructions: 'Review: {{ steps.development.summary }}',
        transitions: [4, 2],
      },
    ],
    ...overrides,
  }
}

const issues = (d: WorkflowDraft, e: ValidationEnv = env) => validateWorkflow(normalizeDraft(d, mint, e.statuses, e.people), e)
const paths = (d: WorkflowDraft, e: ValidationEnv = env) => issues(d, e).map((i) => i.path)

/** A normalised step's transitions without their minted ids. */
const edges = (wf: ReturnType<typeof normalizeDraft>, i: number) =>
  wf.steps[i]?.transitions.map(({ id: _id, ...t }) => t)

test('a sound two-step workflow has no issues, and normalising trims, mints ids and dedupes bare transitions', () => {
  const wf = normalizeDraft(draft(), mint, statuses)
  assert.equal(wf.name, 'Standard')
  assert.ok(wf.id && wf.steps.every((s) => s.id && s.transitions.every((t) => t.id)))
  assert.deepEqual(edges(wf, 0), [{ label: 'On to Review', toStep: wf.steps[1]?.id, status: 3, gate: null }])
  assert.deepEqual(validateWorkflow(wf, env), [])
})

test('a bare status leads to the first step it starts, or ends the run when none does, labelled from where it leads', () => {
  const wf = normalizeDraft(draft(), mint, statuses)
  assert.deepEqual(edges(wf, 1), [
    { label: 'Finish: Done', toStep: null, status: 4, gate: null },
    { label: 'Back to Development', toStep: wf.steps[0]?.id, status: 2, gate: null },
  ])
})

test('a transition names its step by id or name, or "end"/null; omitted, its status decides; label and gate are kept', () => {
  const d = draft()
  d.steps[1] = {
    ...d.steps[1]!,
    transitions: [
      { label: ' Changes requested ', toStep: 'DEVELOPMENT', status: 'in progress' },
      { label: 'Approved', toStep: 'end', status: 4, gate: 'pass' },
      { label: 'Parked', toStep: null, status: 1, gate: 'fail' },
      { status: 2 },
    ],
  }
  const wf = normalizeDraft(d, mint, statuses)
  const dev = wf.steps[0]?.id
  assert.deepEqual(edges(wf, 1), [
    { label: 'Changes requested', toStep: dev, status: 2, gate: null },
    { label: 'Approved', toStep: null, status: 4, gate: 'pass' },
    { label: 'Parked', toStep: null, status: 1, gate: 'fail' },
    { label: 'Back to Development', toStep: dev, status: 2, gate: null },
  ])
  assert.deepEqual(validateWorkflow(wf, env), [])
  const byId = draft()
  byId.steps[0] = { ...byId.steps[0]!, id: 'step-dev' }
  byId.steps[1] = { ...byId.steps[1]!, transitions: [{ label: 'Back', toStep: 'step-dev', status: 2 }] }
  assert.equal(normalizeDraft(byId, mint, statuses).steps[1]?.transitions[0]?.toStep, 'step-dev')
})

test('statuses may be named instead of numbered, case-insensitively; an unknown one lists the valid ones', () => {
  const d = draft()
  d.steps[0] = { ...d.steps[0]!, triggerStatus: 'in progress', transitions: ['Review', '3'] }
  d.steps[1] = { ...d.steps[1]!, triggerStatus: ' REVIEW ', transitions: ['done', 2] }
  const wf = normalizeDraft(d, mint, statuses)
  assert.deepEqual(
    wf.steps.map((s) => [s.triggerStatus, s.transitions.map((t) => t.status)]),
    [
      [2, [3]],
      [3, [4, 2]],
    ],
  )
  assert.deepEqual(validateWorkflow(wf, env), [])

  const unknown = draft()
  unknown.steps[0] = { ...unknown.steps[0]!, triggerStatus: 'Doing', transitions: ['Reveiw'] }
  const listed = 'No such status. Statuses (name or id): To do (1), In progress (2), Review (3), Done (4)'
  assert.deepEqual(issues(unknown), [
    { path: 'steps.0.triggerStatus', message: listed },
    { path: 'steps.0.transitions.0.status', message: listed },
  ])
  const blank = draft()
  blank.steps[0] = { ...blank.steps[0]!, triggerStatus: '' }
  assert.deepEqual(issues(blank)[0], { path: 'steps.0.triggerStatus', message: 'Choose the status that starts this step' })
})

test('a missing name, a name clashing (case-insensitively) with another workflow, and no steps are refused', () => {
  assert.deepEqual(paths(draft({ name: '' })), ['name'])
  assert.deepEqual(paths(draft({ name: 'hotfix' })), ['name'])
  assert.deepEqual(paths(draft({ steps: [] })), ['steps'])
})

test('step names must be distinct by slug, and triggers real', () => {
  const d = draft()
  d.steps[1] = { ...d.steps[1]!, name: 'development!' }
  assert.deepEqual(paths(d), ['steps.1.name'])
  const unknown = draft()
  unknown.steps[0] = { ...unknown.steps[0]!, triggerStatus: 99 }
  assert.deepEqual(paths(unknown), ['steps.0.triggerStatus'])
})

test("a step names no chat: an old draft's chat is dropped, and any agent can be saved (membership is checked when the step opens)", () => {
  const d = draft()
  d.steps[1] = { ...d.steps[1]!, worker: { kind: 'agent', agentNodeId: 'agent_other' } }
  Object.assign(d.steps[0]!, { chat: 'old-project-chat' })
  const wf = normalizeDraft(d, mint, statuses)
  assert.ok(!('chat' in (wf.steps[0] ?? {})))
  assert.deepEqual(validateWorkflow(wf, env), [])
})

test('instructions may only reference EARLIER steps', () => {
  const d = draft()
  d.steps[0] = { ...d.steps[0]!, instructions: 'See {{ steps.review.summary }}' }
  assert.deepEqual(paths(d), ['steps.0.instructions'])
})

test('two steps may start on one status, each sent to by its own transition', () => {
  const d = draft()
  d.steps[1] = { ...d.steps[1]!, name: 'Design', triggerStatus: 2, instructions: '', transitions: [{ label: 'Done', toStep: 'end', status: 4 }] }
  d.steps.push({
    name: 'QA',
    triggerStatus: 3,
    worker: { kind: 'assignee' },
    transitions: [
      { label: 'Back to code', toStep: 'Development', status: 2 },
      { label: 'Back to design', toStep: 'Design', status: 2 },
    ],
  })
  assert.deepEqual(paths(d), [])
})

test('transitions: at least one, real statuses and steps, none into the step itself, labels distinct per step, gates known', () => {
  const d = draft()
  d.steps[0] = { ...d.steps[0]!, transitions: [] }
  d.steps[1] = {
    ...d.steps[1]!,
    transitions: [
      { label: 'Again', toStep: 'Review', status: 2 },
      { label: 'Elsewhere', toStep: 'Nowhere', status: 98 },
      { label: 'again', toStep: 'end', status: 4 },
      { label: 'Odd', status: 4, gate: 'maybe' as 'pass' },
      { label: 'x'.repeat(81), status: 4 },
    ],
  }
  assert.deepEqual(paths(d), [
    'steps.0.transitions',
    'steps.1.transitions.0.toStep',
    'steps.1.transitions.1.status',
    'steps.1.transitions.1.toStep',
    'steps.1.transitions.2.label',
    'steps.1.transitions.3.gate',
    'steps.1.transitions.4.label',
  ])
  const shared = draft()
  shared.steps[1] = { ...shared.steps[1]!, transitions: [{ id: 't1', status: 4 }, { id: 't1', label: 'Back', status: 2 }] }
  assert.deepEqual(paths(shared), ['steps.1.transitions.1'])
})

test("a step's folder is trimmed, blank or omitted is the top level, and a long one is refused", () => {
  const d = draft()
  d.steps[0] = { ...d.steps[0]!, folder: '  Development ' }
  d.steps[1] = { ...d.steps[1]!, folder: '   ' }
  const wf = normalizeDraft(d, mint, statuses)
  assert.deepEqual(
    wf.steps.map((s) => s.folder),
    ['Development', ''],
  )
  assert.equal(normalizeDraft(draft(), mint, statuses).steps[0]?.folder, '', 'omitted')
  assert.deepEqual(validateWorkflow(wf, env), [])
  const long = draft()
  long.steps[1] = { ...long.steps[1]!, folder: 'x'.repeat(81) }
  assert.deepEqual(issues(long), [{ path: 'steps.1.folder', message: 'Keep the folder name under 80 characters' }])
})

test("a step's session options keep only what is set, and a presence only its own fields", () => {
  const d = draft()
  d.steps[0] = {
    ...d.steps[0]!,
    sessionOptions: {
      effort: ' high ' as 'high',
      permissionMode: '' as 'plan',
      presence: { kind: 'online', intervalMs: 5 } as unknown as { kind: 'online' },
    },
  }
  const wf = normalizeDraft(d, mint, statuses)
  assert.deepEqual(
    wf.steps.map((s) => s.sessionOptions),
    [{ effort: 'high', presence: { kind: 'online' } }, {}],
    'blank is not set, and omitted is none',
  )
  assert.deepEqual(validateWorkflow(wf, env), [])
})

test('session options outside the command bar’s vocabulary, and a custom presence off whole minutes, are refused', () => {
  const d = draft()
  d.steps[0] = {
    ...d.steps[0]!,
    sessionOptions: {
      effort: 'turbo' as 'high',
      permissionMode: 'yolo' as 'plan',
      presence: { kind: 'custom', intervalMs: 90_000 },
    },
  }
  d.steps[1] = { ...d.steps[1]!, sessionOptions: { presence: { kind: 'weekly' } as unknown as { kind: 'daily' } } }
  assert.deepEqual(paths(d), [
    'steps.0.sessionOptions.effort',
    'steps.0.sessionOptions.permissionMode',
    'steps.0.sessionOptions.presence',
    'steps.1.sessionOptions.presence',
  ])
  const ok = draft()
  ok.steps[0] = { ...ok.steps[0]!, sessionOptions: { presence: { kind: 'custom', intervalMs: 600_000 } } }
  assert.deepEqual(paths(ok), [])
})

test("a step's compaction threshold is kept as a number, blank is not set, and only a whole count of tokens passes", () => {
  const d = draft()
  d.steps[0] = { ...d.steps[0]!, sessionOptions: { compactAbove: '150000' as unknown as number } }
  d.steps[1] = { ...d.steps[1]!, sessionOptions: { compactAbove: '  ' as unknown as number } }
  const wf = normalizeDraft(d, mint, statuses)
  assert.deepEqual(
    wf.steps.map((s) => s.sessionOptions),
    [{ compactAbove: 150_000 }, {}],
  )
  assert.deepEqual(validateWorkflow(wf, env), [])

  const never = draft()
  never.steps[0] = { ...never.steps[0]!, sessionOptions: { compactAbove: 0 } }
  assert.deepEqual(paths(never), [], '0 is never')

  const bad = draft()
  bad.steps[0] = { ...bad.steps[0]!, sessionOptions: { compactAbove: -1 } }
  bad.steps[1] = { ...bad.steps[1]!, sessionOptions: { compactAbove: 'lots' as unknown as number } }
  assert.deepEqual(paths(bad), ['steps.0.sessionOptions.compactAbove', 'steps.1.sessionOptions.compactAbove'])
})

test("a step without instructions gets the task's key and summary; an empty string stays empty", () => {
  const d = draft()
  const { instructions: _omitted, ...bare } = d.steps[0]!
  d.steps[0] = bare
  d.steps[1] = { ...d.steps[1]!, instructions: '' }
  const wf = normalizeDraft(d, mint, statuses)
  assert.deepEqual(
    wf.steps.map((s) => s.instructions),
    ['{{ task.key }}: {{ task.summary }}', ''],
  )
  assert.deepEqual(validateWorkflow(wf, env), [])
})

test('an agent worker needs an agent', () => {
  const d = draft()
  d.steps[1] = { ...d.steps[1]!, worker: { kind: 'agent', agentNodeId: ' ' } }
  assert.deepEqual(paths(d), ['steps.1.worker'])
})

/** The draft with its Review step made an approval step decided by `approval`. */
function approvalDraft(approval: NonNullable<WorkflowDraft['steps'][number]['approval']>): WorkflowDraft {
  const d = draft()
  d.steps[1] = { ...d.steps[1]!, kind: 'approval', approval }
  return d
}

test('a step is an agent step unless it says otherwise, and an agent step has no approval', () => {
  const wf = normalizeDraft(draft(), mint, statuses, people)
  assert.deepEqual(
    wf.steps.map((s) => [s.kind, s.approval]),
    [
      ['agent', null],
      ['agent', null],
    ],
  )
  const d = draft()
  d.steps[0] = { ...d.steps[0]!, kind: 'robot' as never }
  assert.deepEqual(issues(d), [{ path: 'steps.0.kind', message: 'No step kind "robot". Kinds: agent, approval' }])
})

test('an approval step keeps its approvers by id, resolves one given by name, needs the required count by default, and has no session settings', () => {
  const d = approvalDraft({ approvers: [{ personId: 'person-alice', required: true }, { name: ' bob ' }] })
  d.steps[1] = { ...d.steps[1]!, folder: 'Reviews', sessionOptions: { effort: 'high' } }
  const wf = normalizeDraft(d, mint, statuses, people)
  const step = wf.steps[1]!
  assert.equal(step.kind, 'approval')
  assert.deepEqual(step.approval, {
    approvers: [
      { personId: 'person-alice', name: 'Alice', required: true },
      { personId: 'person-bob', name: 'Bob', required: false },
    ],
    needed: 1,
  })
  assert.deepEqual([step.worker, step.instructions, step.folder, step.sessionOptions], [{ kind: 'assignee' }, '', '', {}])
  assert.deepEqual(validateWorkflow(wf, env), [])
  const none = approvalDraft({ approvers: [{ personId: 'person-alice' }] })
  assert.equal(normalizeDraft(none, mint, statuses, people).steps[1]?.approval?.needed, 1, 'no required approver still needs one approval')
})

test('approvers are people of the directory, each once', () => {
  assert.deepEqual(issues(approvalDraft({ approvers: [] })), [{ path: 'steps.1.approval.approvers', message: 'Add at least one approver' }])
  assert.deepEqual(issues(approvalDraft({ approvers: [{ name: 'Agent A' }, { personId: 'person-nobody' }] })), [
    { path: 'steps.1.approval.approvers.0', message: '"Agent A" is not a person in the directory: only people can approve' },
    { path: 'steps.1.approval.approvers.1', message: '"person-nobody" is not a person in the directory: only people can approve' },
  ])
  assert.deepEqual(issues(approvalDraft({ approvers: [{ personId: 'person-bob' }, { name: 'Bob' }] })), [
    { path: 'steps.1.approval.approvers.1', message: 'Bob is already an approver of this step' },
  ])
})

test('approvals needed lie between the required approvers (at least 1) and every approver', () => {
  const approvers = [{ personId: 'person-alice', required: true }, { personId: 'person-bob', required: true }, { personId: 'person-carol' }]
  const range = 'Approvals needed must be a whole number from 2 (the required approvers, at least 1) to 3 (every approver)'
  for (const needed of [1, 4, 2.5]) {
    assert.deepEqual(issues(approvalDraft({ approvers, needed })), [{ path: 'steps.1.approval.needed', message: range }], `needed ${needed}`)
  }
  for (const needed of [2, 3]) {
    assert.deepEqual(issues(approvalDraft({ approvers, needed })), [], `needed ${needed}`)
  }
  assert.deepEqual(paths(approvalDraft({ approvers: [{ personId: 'person-alice' }], needed: 0 })), ['steps.1.approval.needed'])
})

test('an approval step needs a pass transition to approve by and a fail one to reject by', () => {
  const approval = { approvers: [{ personId: 'person-alice' }] }
  const passOnly = approvalDraft(approval)
  passOnly.steps[1] = { ...passOnly.steps[1]!, transitions: [4] }
  assert.deepEqual(issues(passOnly), [
    { path: 'steps.1.transitions', message: 'Give the step a transition with a fail gate for its approvers to reject by' },
  ])
  const failOnly = approvalDraft(approval)
  failOnly.steps[1] = { ...failOnly.steps[1]!, transitions: [2] }
  assert.deepEqual(issues(failOnly), [
    { path: 'steps.1.transitions', message: 'Give the step a transition with a pass gate for its approvers to approve by' },
  ])
  const overridden = approvalDraft(approval)
  overridden.steps[1] = { ...overridden.steps[1]!, transitions: [4, { status: 1, toStep: 'end', gate: 'fail' }] }
  assert.deepEqual(issues(overridden), [], 'a gate override counts')
})
