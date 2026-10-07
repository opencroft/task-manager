// The one chat the task manager talks in: its space's. The host treats the
// group chat at a space's own address (its slug is the space's slug) as that
// space's chat, so workflow steps, mention sessions and the embedded project
// chat all open their threads there. The App never creates that chat and
// never adds members to it: when a thread cannot open, the reason says who
// has to do what.

/** A chat as the host lists it for the task manager's own identity. */
export interface SpaceChatListing {
  ref: string
  slug: string
  name: string
  agents: Array<{ nodeId: string; name: string }>
}

/** The part of the host's group chats that says which chats the task manager is in. */
export interface SpaceChatLister {
  list(): Promise<SpaceChatListing[]>
}

export const NO_GROUP_CHATS = 'This host offers no group chats to extensions, so no session can be opened'

/** Why the task manager cannot talk in the space's chat at all. */
export const notInSpaceChat = (spaceSlug: string) =>
  `The task manager isn't in this space's chat ("${spaceSlug}") yet: a person grants it in the task manager's Settings → Chat`

/** Why an agent's thread cannot open in the space's chat. */
export const agentNotInSpaceChat = (agentName: string) => `${agentName} isn't in this space's chat`

/** The space's chat, when the task manager is in it; null when it is not (or the space has no chat). */
export async function findSpaceChat(chats: SpaceChatLister, spaceSlug: string): Promise<SpaceChatListing | null> {
  return (await chats.list()).find((chat) => chat.slug === spaceSlug) ?? null
}

/** Which of the reasons a thread cannot open applies. */
export type SpaceChatProblemKind = 'no_chats' | 'not_in_chat' | 'agent_not_in_chat'

/**
 * The chat a thread for `agentNodeId` opens in, or the plain reason it cannot:
 * no group chats on this host, the task manager not in the space's chat, or
 * the agent not in it.
 */
export async function spaceChatFor(
  chats: SpaceChatLister | null,
  spaceSlug: string,
  agent: { nodeId: string; name: string },
): Promise<{ chat: SpaceChatListing } | { problem: string; kind: SpaceChatProblemKind }> {
  if (!chats) {
    return { problem: NO_GROUP_CHATS, kind: 'no_chats' }
  }
  const chat = await findSpaceChat(chats, spaceSlug)
  if (!chat) {
    return { problem: notInSpaceChat(spaceSlug), kind: 'not_in_chat' }
  }
  if (!chat.agents.some((member) => member.nodeId === agent.nodeId)) {
    return { problem: agentNotInSpaceChat(agent.name), kind: 'agent_not_in_chat' }
  }
  return { chat }
}
