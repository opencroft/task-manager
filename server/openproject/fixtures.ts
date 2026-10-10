// OpenProject API v3 responses for the import tests, in the HAL shapes an
// OpenProject 16 server returns (trimmed to the fields the import reads, plus
// a few it must ignore). A made-up project: nothing here came from a real
// instance, and nothing is secret.

import { createHash } from 'node:crypto'

export const BASE = 'https://openproject.example.com'
export const TOKEN = 'op-test-token-4f1e9c'

const link = (href: string | null, title?: string) => (title === undefined ? { href } : { href, title })

export function statusesBody() {
  const status = (id: number, name: string, isClosed: boolean, color: string, position: number) => ({
    _type: 'Status',
    id,
    name,
    isClosed,
    color,
    isDefault: id === 1,
    isReadonly: false,
    defaultDoneRatio: 0,
    position,
    _links: { self: link(`/api/v3/statuses/${id}`, name) },
  })
  const elements = [
    status(1, 'Backlog', false, '#878787', 1),
    status(7, 'In progress', false, '#FFCC00', 2),
    status(9, 'In testing', false, '#22B8CF', 3),
    status(12, 'Closed', true, '#35C53F', 4),
    status(14, 'Rejected', true, '#FFA8A8', 5),
  ]
  return { _type: 'Collection', total: elements.length, count: elements.length, _embedded: { elements } }
}

export function projectBody() {
  return {
    _type: 'Project',
    id: 4,
    identifier: 'DEMO',
    name: 'Demo',
    active: true,
    public: false,
    description: { format: 'markdown', raw: '', html: '' },
    _links: { self: link('/api/v3/projects/4', 'Demo'), workPackages: link('/api/v3/workspaces/4/work_packages') },
  }
}

export function typesBody() {
  const type = (id: number, name: string, isMilestone: boolean, position: number) => ({
    _type: 'Type',
    id,
    name,
    isMilestone,
    position,
    _links: { self: link(`/api/v3/types/${id}`, name) },
  })
  const elements = [
    type(1, 'Task', false, 1),
    type(2, 'Milestone', true, 2),
    type(3, 'Summary task', false, 3),
    type(7, 'Bug', false, 7),
    type(8, 'Design', false, 8),
  ]
  return { _type: 'Collection', total: elements.length, count: elements.length, _embedded: { elements } }
}

export interface WorkPackageFixture {
  id: number
  number: number
  subject: string
  description?: string
  type: [number, string]
  status: [number, string]
  priority?: string
  assignee?: [number, string]
  author: [number, string]
  parent?: number
  startDate?: string | null
  dueDate?: string | null
  date?: string | null
  updatedAt?: string
}

export function workPackage(fixture: WorkPackageFixture) {
  const [typeId, typeName] = fixture.type
  const [statusId, statusName] = fixture.status
  const milestone = typeName === 'Milestone'
  return {
    _type: 'WorkPackage',
    id: fixture.id,
    displayId: `DEMO-${fixture.number}`,
    lockVersion: 3,
    subject: fixture.subject,
    description: { format: 'markdown', raw: fixture.description ?? '', html: '<p>(rendered)</p>' },
    scheduleManually: true,
    ...(milestone
      ? { date: fixture.date ?? null }
      : { startDate: fixture.startDate ?? null, dueDate: fixture.dueDate ?? null }),
    duration: null,
    ignoreNonWorkingDays: false,
    estimatedTime: null,
    spentTime: 'PT0S',
    percentageDone: null,
    position: fixture.id,
    storyPoints: null,
    createdAt: `2026-07-${String(10 + (fixture.id % 10)).padStart(2, '0')}T09:00:00.000Z`,
    updatedAt: fixture.updatedAt ?? '2026-09-01T12:00:00.000Z',
    _links: {
      self: link(`/api/v3/work_packages/${fixture.id}`, fixture.subject),
      activities: link(`/api/v3/work_packages/${fixture.id}/activities`),
      type: link(`/api/v3/types/${typeId}`, typeName),
      status: link(`/api/v3/statuses/${statusId}`, statusName),
      priority: link('/api/v3/priorities/8', fixture.priority ?? 'Normal'),
      author: link(`/api/v3/users/${fixture.author[0]}`, fixture.author[1]),
      assignee: fixture.assignee ? link(`/api/v3/users/${fixture.assignee[0]}`, fixture.assignee[1]) : link(null),
      responsible: link(null),
      category: link(null),
      project: link('/api/v3/projects/4', 'Demo'),
      parent: fixture.parent ? link(`/api/v3/work_packages/${fixture.parent}`, 'parent') : link(null),
      ancestors: fixture.parent ? [link(`/api/v3/work_packages/${fixture.parent}`, 'parent')] : [],
      targetVersions: [],
      customActions: [],
    },
  }
}

const BOB: [number, string] = [5, 'Bob (Lead Agent)']
const CAROL: [number, string] = [10, 'Carol (Agent)']
const JANE: [number, string] = [21, 'Jane Doe']
const PAT: [number, string] = [30, 'Pat Outsider']

/** The project's work packages, by id. 105 is a milestone; 107's parent is in another project. */
export function workPackageFixtures(): WorkPackageFixture[] {
  return [
    {
      id: 101,
      number: 1,
      subject: 'Launch the demo',
      type: [3, 'Summary task'],
      status: [7, 'In progress'],
      author: BOB,
      assignee: BOB,
      startDate: '2026-09-01',
      dueDate: '2026-09-30',
    },
    {
      id: 102,
      number: 2,
      subject: 'Write the landing page',
      description:
        'Ask <mention class="mention" data-id="21" data-type="user" data-text="@Jane Doe">@Jane Doe</mention> for copy. Mock-up: [design](/api/v3/attachments/9/content), spec in #103.',
      type: [1, 'Task'],
      status: [12, 'Closed'],
      priority: 'High',
      author: BOB,
      assignee: CAROL,
      parent: 101,
      startDate: '2026-09-02',
      dueDate: '2026-09-05',
    },
    {
      id: 103,
      number: 3,
      subject: 'Login fails on Safari',
      type: [7, 'Bug'],
      status: [9, 'In testing'],
      priority: 'Immediate',
      author: JANE,
      assignee: JANE,
      parent: 101,
      startDate: '2026-09-10',
    },
    {
      id: 104,
      number: 4,
      subject: 'Visual design',
      type: [8, 'Design'],
      status: [1, 'Backlog'],
      author: JANE,
      parent: 101,
    },
    {
      id: 105,
      number: 5,
      subject: 'Go live',
      type: [2, 'Milestone'],
      status: [1, 'Backlog'],
      author: BOB,
      parent: 101,
      date: '2026-09-30',
    },
    {
      id: 106,
      number: 6,
      subject: 'Pick the colour palette',
      type: [1, 'Task'],
      status: [14, 'Rejected'],
      priority: 'Low',
      author: PAT,
      assignee: PAT,
      parent: 104,
    },
    {
      id: 107,
      number: 7,
      subject: 'Share the demo with sales',
      type: [1, 'Task'],
      status: [1, 'Backlog'],
      author: BOB,
      parent: 999,
    },
  ]
}

export function workPackagesPage(all: WorkPackageFixture[], offset: number, pageSize: number) {
  const elements = all.slice((offset - 1) * pageSize, offset * pageSize).map(workPackage)
  return {
    _type: 'WorkPackageCollection',
    total: all.length,
    count: elements.length,
    pageSize,
    offset,
    _embedded: { elements },
  }
}

export interface CommentFixture {
  id: number
  user: number
  body: string
  internal?: boolean
  at: string
}

/** Each work package's journal: comments, plus field-change entries with an empty comment that are not comments. */
export function commentFixtures(): Record<number, CommentFixture[]> {
  return {
    101: [
      { id: 5001, user: 5, body: 'Kick-off: the demo ships at the end of September.', at: '2026-09-01T10:00:00.000Z' },
      {
        id: 5002,
        user: 5,
        body: '_Updated automatically by changing values within child work package #102_\n',
        at: '2026-09-05T10:00:00.000Z',
      },
    ],
    102: [
      { id: 5003, user: 10, body: 'Done, see the preview link.', at: '2026-09-05T16:00:00.000Z' },
      {
        id: 5004,
        user: 21,
        body: 'Salary figures for the case study are in the HR folder.',
        internal: true,
        at: '2026-09-05T17:00:00.000Z',
      },
      { id: 5005, user: 44, body: 'Looks good to me.', at: '2026-09-06T08:00:00.000Z' },
    ],
    103: [{ id: 5006, user: 21, body: 'Reproduced on Safari 17 only.', at: '2026-09-11T09:30:00.000Z' }],
  }
}

export function activitiesBody(workPackageId: number, comments: CommentFixture[]) {
  const journal = (id: number, user: number, body: string, internal: boolean, at: string) => ({
    _type: body ? 'Activity::Comment' : 'Activity',
    id,
    comment: { format: 'markdown', raw: body, html: body ? '<p>…</p>' : '' },
    details: body ? [] : [{ format: 'custom', raw: 'Status changed from Backlog to In progress', html: '…' }],
    internal,
    version: 1,
    createdAt: at,
    updatedAt: at,
    _links: {
      self: link(`/api/v3/activities/${id}`),
      workPackage: link(`/api/v3/work_packages/${workPackageId}`),
      user: link(`/api/v3/users/${user}`),
    },
  })
  const elements = [
    journal(workPackageId * 100, 5, '', false, '2026-07-10T09:00:00.000Z'),
    ...comments.map((comment) =>
      journal(comment.id, comment.user, comment.body, comment.internal ?? false, comment.at),
    ),
  ]
  return {
    _type: 'Collection',
    total: elements.length,
    count: elements.length,
    _embedded: { elements },
    _links: { self: link(`/api/v3/work_packages/${workPackageId}/activities`) },
  }
}

/** Users only met on a comment, as `/api/v3/users/{id}` answers for them. */
export const extraUsers: Record<number, string> = { 44: 'Alex Reviewer' }

export interface AttachmentFixture {
  id: number
  fileName: string
  bytes: Buffer
  author: [number, string]
  at: string
  /** The size OpenProject reports, where it differs from the bytes (a file too large to put in a test). */
  fileSize?: number
}

/** `/api/v3/work_packages/{id}/attachments`, as OpenProject 16 answers it. */
export function attachmentsBody(workPackageId: number, attachments: AttachmentFixture[]) {
  const elements = attachments.map((attachment) => ({
    _type: 'Attachment',
    id: attachment.id,
    fileName: attachment.fileName,
    fileSize: attachment.fileSize ?? attachment.bytes.length,
    // What the uploader's browser said; the import decides the type from the bytes.
    contentType: 'application/octet-stream',
    description: { format: 'plain', raw: '', html: '' },
    status: 'uploaded',
    digest: { algorithm: 'md5', hash: createHash('md5').update(attachment.bytes).digest('hex') },
    createdAt: attachment.at,
    _links: {
      self: link(`/api/v3/attachments/${attachment.id}`, attachment.fileName),
      author: link(`/api/v3/users/${attachment.author[0]}`, attachment.author[1]),
      container: link(`/api/v3/work_packages/${workPackageId}`, 'work package'),
      downloadLocation: link(`/api/v3/attachments/${attachment.id}/content`),
      staticDownloadLocation: link(`/api/v3/attachments/${attachment.id}/content`),
    },
  }))
  return { _type: 'Collection', total: elements.length, count: elements.length, _embedded: { elements } }
}
