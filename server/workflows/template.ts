/**
 * Step instruction templates: plain text with `{{ path }}` placeholders.
 *
 * The set of paths is closed and known in advance, so a definition is checked
 * when it is SAVED (see `definition.ts`), not discovered broken when a session
 * opens. Rendering leaves an unknown placeholder as written rather than
 * dropping it, so a template that somehow skipped validation shows its
 * mistake in the session instead of silently losing text.
 *
 * Earlier steps are addressed by the slug of their name —
 * `{{ steps.code-review.summary }}` — because a name is what the person
 * writing the template sees, and ids are not.
 */

export const TASK_FIELDS = ['key', 'summary', 'description', 'status', 'type', 'priority', 'assignee', 'url'] as const
export const STEP_FIELDS = ['outcome', 'summary', 'agent', 'thread'] as const

export type TaskField = (typeof TASK_FIELDS)[number]
export type StepField = (typeof STEP_FIELDS)[number]

export interface TemplateContext {
  task: Partial<Record<TaskField, string | null | undefined>>
  step: { name: string }
  workflow: { name: string }
  /** Earlier steps' results, keyed by step-name slug. A step not reached yet is absent. */
  steps: Record<string, Partial<Record<StepField, string | null | undefined>>>
}

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g

/** The step-name slug templates use: lower case, runs of anything else collapsed to one `-`. */
export function stepSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export interface Placeholder {
  /** The path as written, trimmed. */
  path: string
  /** Character offset of the opening `{{`. */
  index: number
}

export function placeholders(template: string): Placeholder[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => ({ path: m[1] ?? '', index: m.index ?? 0 }))
}

/**
 * Why a placeholder path is not one this renderer can fill, or null when it is.
 * `earlierSteps` are the slugs a step may refer to — the steps BEFORE it, since
 * a later step's result cannot exist when this one opens the first time.
 */
export function placeholderProblem(path: string, earlierSteps: ReadonlySet<string>): string | null {
  const parts = path.split('.')
  const [root] = parts
  if (root === 'task') {
    return parts.length === 2 && (TASK_FIELDS as readonly string[]).includes(parts[1] ?? '')
      ? null
      : `"{{ ${path} }}" is not a task field; use one of: ${TASK_FIELDS.map((f) => `task.${f}`).join(', ')}`
  }
  if (root === 'step' || root === 'workflow') {
    return parts.length === 2 && parts[1] === 'name' ? null : `"{{ ${path} }}" is not available; use {{ ${root}.name }}`
  }
  if (root === 'steps') {
    const [, slug = '', field = ''] = parts
    if (parts.length !== 3 || !(STEP_FIELDS as readonly string[]).includes(field)) {
      return `"{{ ${path} }}" should be steps.<step>.<field>, with field one of: ${STEP_FIELDS.join(', ')}`
    }
    return earlierSteps.has(slug)
      ? null
      : `"{{ ${path} }}" names no earlier step; earlier steps: ${[...earlierSteps].join(', ') || 'none'}`
  }
  return `"{{ ${path} }}" is unknown; placeholders start with task., step., workflow. or steps.`
}

function lookup(path: string, ctx: TemplateContext): string | undefined {
  const parts = path.split('.')
  const [root] = parts
  if (root === 'task' && parts.length === 2) {
    const key = parts[1] as TaskField
    return (TASK_FIELDS as readonly string[]).includes(key) ? (ctx.task[key] ?? '') : undefined
  }
  if ((root === 'step' || root === 'workflow') && parts.length === 2 && parts[1] === 'name') {
    return ctx[root].name
  }
  if (root === 'steps' && parts.length === 3) {
    const field = parts[2] as StepField
    if (!(STEP_FIELDS as readonly string[]).includes(field)) {
      return undefined
    }
    return ctx.steps[parts[1] ?? '']?.[field] ?? ''
  }
  return undefined
}

export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(PLACEHOLDER, (whole, path: string) => lookup(path.trim(), ctx) ?? whole)
}
