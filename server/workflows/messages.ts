/**
 * What a step's session is told: the opening message of its thread, the
 * message that sends a task back to a step it already worked, and the notice
 * that a run was cancelled. Pure text builders, so the wording is tested and
 * the engine only decides WHEN each goes out.
 *
 * Every message ends with the exact `app_call` that finishes the step. An
 * agent that has to discover its way back to the workflow will guess, and a
 * guess at an action name costs a failed turn.
 */

export interface StepMessageInput {
  /** The App's address, `<space>.<app>` — what `app_call` takes. */
  app: string
  taskKey: string
  stepName: string
  /** The step's instructions, already rendered. */
  instructions: string
  /** Labels of the transitions the agent may finish by, in order. */
  transitions: string[]
}

function finishHowTo(input: StepMessageInput): string {
  const example = JSON.stringify({
    task: input.taskKey,
    transition: input.transitions[0] ?? '<transition>',
    summary: 'What you did, and anything the next step needs to know',
  })
  return [
    '**When you are done**, finish this step (this moves the task on and starts the next step):',
    `\`app_call { app: "${input.app}", action: "workflow_step_finish", params: ${example} }\``,
    `Allowed \`transition\` values: ${input.transitions.map((t) => `"${t}"`).join(', ')}.`,
    'Your `summary` is posted on the task as a comment and shown to the next step, so do not also post it with `task_comment`.',
    '',
    `Read the task with \`task_get {"key":"${input.taskKey}"}\` and the whole run with \`workflow_run_get {"task":"${input.taskKey}"}\` — same app.`,
  ].join('\n')
}

/**
 * The step's instructions as its author wrote them, then how to finish. Nothing
 * is put before them: a step names its task through its own placeholders, so
 * the message never says the same thing twice.
 */
export function openingMessage(input: StepMessageInput): string {
  const instructions = input.instructions.trim()
  return instructions ? `${instructions}\n\n${finishHowTo(input)}` : finishHowTo(input)
}

export interface ReworkInput extends StepMessageInput {
  attempt: number
  from: string
  movedBy: string
  /** What the step that sent it back said, when it said something. */
  reason: string | null
  /**
   * The session was compacted just before this message, so it may no longer
   * hold the step's opening message: the instructions are given again.
   */
  compacted?: boolean
}

export function reworkMessage(input: ReworkInput): string {
  const parts = [
    `**${input.taskKey} is back at ${input.stepName}** (round ${input.attempt}): ${input.movedBy} moved it from "${input.from}".`,
  ]
  if (input.reason?.trim()) {
    parts.push(`Their notes:\n\n${input.reason.trim()}`)
  }
  if (input.compacted) {
    const note = 'This session was compacted before this round. Re-read the task and the run before you continue.'
    const instructions = input.instructions.trim()
    parts.push(instructions ? `${note} The step's instructions:\n\n${instructions}` : note)
  }
  parts.push('Continue in this thread, then finish the step again.')
  parts.push(finishHowTo(input))
  return parts.join('\n\n')
}

export function cancelledMessage(input: { taskKey: string; by: string }): string {
  return `**The workflow run for ${input.taskKey} was cancelled by ${input.by}.** Stop work on this step; nothing further is expected in this thread.`
}
