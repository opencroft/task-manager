// Who a comment mentions, asked of the host: a mention is `@<username>` in
// prose, never in code, and it is exactly what the comment renders as a
// mention chip. Both the inbox and the agent sessions read it from here, so
// a notification and a session start from the same answer.

import { mentions as hostMentions } from '@opencroft/server/people'

import type { Party } from '../inbox/store.ts'

/** The people and agents a comment's markdown mentions, each once, in order. */
export async function mentionedIn(body: string): Promise<Party[]> {
  if (!body.includes('@')) {
    return []
  }
  const mentions = await hostMentions.find(body)
  return mentions.map((mention) => ({
    kind: mention.kind === 'agent' ? 'agent' : 'person',
    id: mention.id,
    name: mention.name,
  }))
}
