// How a status reference names a status: by id (a number, or a string of
// digits) or by name in any case. A leaf, so a migration can use it.

import type { StatusRef } from '../shared/types.ts'

/** The status of `statuses` that `ref` names, if any. */
export function findStatus<S extends { id: number; name: string }>(
  statuses: readonly S[],
  ref: StatusRef,
): S | undefined {
  const text = String(ref).trim()
  return typeof ref === 'number' || /^\d+$/.test(text)
    ? statuses.find((status) => status.id === Number(ref))
    : statuses.find((status) => status.name.toLowerCase() === text.toLowerCase())
}
