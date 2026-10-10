// Who may connect the forge, and with what: host-free, so the tests run it.
// Only a person sets the address and the key name. An agent that could would
// be able to send any stored secret to an address of its choosing.

import { FORGE_SECRET_PREFIX, type ForgeConnection } from '../../shared/forge.ts'
import type { Db } from '../db.ts'
import { TaskError } from '../service.ts'
import { normalizeForgeUrl } from './api.ts'
import { readConnection } from './store.ts'

export function checkConnection(input: Partial<ForgeConnection>, byPerson: boolean): ForgeConnection {
  if (!byPerson) {
    throw new TaskError('Only a person connects the forge, in Settings → Pull requests.')
  }
  return validConnection(input)
}

/** The rules a connection meets, whoever or whatever wrote it. */
function validConnection(input: Partial<ForgeConnection>): ForgeConnection {
  const url = normalizeForgeUrl(input.url)
  const owner = String(input.owner ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner)) {
    throw new TaskError('Give the organisation or user whose repositories to read (owner), e.g. opencroft')
  }
  const secretKey = String(input.secretKey ?? '').trim()
  if (!secretKey.startsWith(FORGE_SECRET_PREFIX) || secretKey.length === FORGE_SECRET_PREFIX.length) {
    throw new TaskError(
      `Name the Secrets Store key holding the forge token (secretKey); it starts with ${FORGE_SECRET_PREFIX}, e.g. FORGEJO_TASKS_TOKEN`,
    )
  }
  return { url, owner, secretKey }
}

/**
 * The saved connection, if it still meets those rules, before any secret is
 * looked up for it. Connecting checks them, but a row can also arrive another
 * way (a project file restored, a row from before a rule): such a connection
 * is reported instead of read, so a stored token never goes to an address or
 * under a key name that connecting would have refused.
 */
export function usableConnection(db: Db): { connection: ForgeConnection | null; problem: string | null } {
  const saved = readConnection(db)
  if (!saved) {
    return { connection: null, problem: null }
  }
  try {
    return { connection: validConnection(saved), problem: null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      connection: null,
      problem: `The saved connection is not one Settings accepts, so the forge is not read: ${reason}. Connect again in Settings → Pull requests.`,
    }
  }
}
