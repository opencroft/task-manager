/**
 * What a mentioned agent is told: the opening message of its session on a
 * task, and each later mention in the same thread. Pure text builders, like
 * the workflow's, so the wording is tested and the engine only decides when
 * each goes out.
 *
 * Both end with the exact `app_call` that answers on the task: an agent left
 * to find its own way back guesses, and a guessed action name costs a turn.
 */

export interface MentionMessageInput {
  /** The App's address, `<space>.<app>`: what `app_call` takes. */
  app: string
  task: { key: string; summary: string; description: string; status: string; assignee: string | null }
  comment: { author: string; body: string }
}

function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

function answerHowTo(input: MentionMessageInput): string {
  const example = JSON.stringify({ key: input.task.key, body: 'Your answer, in markdown' })
  return [
    '**Answer on the task**, not only here, so everyone on it sees it:',
    `\`app_call { app: "${input.app}", action: "task_comment", params: ${example} }\``,
    `If you are asked to change the task (status, assignee, dates, fields), do it with the usual actions of the same app, e.g. \`task_update {"key":"${input.task.key}", ...}\` or \`task_change_status\`. Every change is recorded under your name.`,
    `Read the whole task with \`task_get {"key":"${input.task.key}"}\`. Writing @${input.comment.author} in your comment notifies them.`,
  ].join('\n')
}

export function mentionOpeningMessage(input: MentionMessageInput): string {
  const { task } = input
  const facts = [
    `**${task.key}: ${task.summary}**`,
    `Status: ${task.status}. Assignee: ${task.assignee ?? 'nobody'}.`,
  ]
  if (task.description.trim()) {
    facts.push(`Description:\n${quote(task.description)}`)
  }
  return [
    `**${input.comment.author}** mentioned you in a comment on ${task.key}:`,
    quote(input.comment.body),
    facts.join('\n'),
    answerHowTo(input),
  ].join('\n\n')
}

export function mentionFollowUpMessage(input: MentionMessageInput): string {
  return [
    `**${input.comment.author}** mentioned you again on ${input.task.key} (${input.task.status}):`,
    quote(input.comment.body),
    answerHowTo(input),
  ].join('\n\n')
}
