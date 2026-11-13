import { apps } from '@opencroft/server/apps'
import { type SecretScope, secrets } from '@opencroft/server/secrets'

/**
 * The space a `tasks` instance is in at this moment. Asked of the host rather than taken from the
 * context a timer was started with: an instance can be moved to another space while its timer runs.
 */
async function currentSpaceOf(instanceId: string): Promise<string> {
  const instance = (await apps.listInstances('tasks')).find((i) => i.instanceId === instanceId)
  if (!instance) {
    throw new Error(`The tasks instance ${instanceId} is not added`)
  }
  return instance.spaceSlug
}

/**
 * A secret this instance names by key (a forge or OpenProject token), from the Secrets Stores in
 * the instance's own space; null when none there holds it.
 */
export async function resolveInstanceSecret(instanceId: string, key: string): Promise<string | null> {
  const scope: SecretScope = { spaceSlug: await currentSpaceOf(instanceId) }
  return secrets.resolve(key, scope)
}
