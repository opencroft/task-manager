// A task's history with its description edits' texts, fetched while the
// History tab shows it: once per version of the entries that have texts, so a
// live reload that changed none of them fetches nothing.

import { useEffect, useMemo, useState } from 'react'

import type { ActivityEntry, ActivityTexts, TaskKey } from '../../shared/types'
import type { TasksApi } from '../lib/api'
import { textsByStamp, textsMissing, textsWanted, withActivityTexts } from './activity-texts'

export function useActivityTexts(
  api: TasksApi,
  taskKey: TaskKey,
  entries: ActivityEntry[],
  shown: boolean,
  fail: (error: unknown) => void,
): ActivityEntry[] {
  const [byStamp, setByStamp] = useState<Map<string, ActivityTexts>>(() => new Map())
  const wanted = textsWanted(entries)
  const fetchNeeded = shown && textsMissing(wanted, byStamp)

  useEffect(() => {
    if (!fetchNeeded) {
      return
    }
    let live = true
    api.task_activity_texts({ key: taskKey }).then(
      (result) => {
        if (live) {
          setByStamp(textsByStamp(wanted, result.entries))
        }
      },
      (error) => {
        if (live) {
          fail(error)
        }
      },
    )
    return () => {
      live = false
    }
  }, [api, taskKey, wanted, fetchNeeded, fail])

  return useMemo(() => withActivityTexts(entries, byStamp), [entries, byStamp])
}
