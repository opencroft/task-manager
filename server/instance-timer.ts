// One timer per `tasks` instance, running a job every few seconds. The timers
// live on globalThis under the job's own key and call whichever `tick` the
// newest server module registered: a deploy reloads the modules without
// running onLoad again, so a timer set by the old module must run the new
// code, and a second timer must never start beside it.

/** What a job needs to find the instance's database and project key. */
export interface TimerTarget {
  instanceId: string
  dataDir: string
  params: Record<string, string>
}

type Tick = (target: TimerTarget) => Promise<void>

interface Entry {
  target: TimerTarget
  timer: ReturnType<typeof setInterval>
  /** The run in flight, if any: a slow run is never overlapped by the next. */
  running: Promise<void> | null
}

interface Registry {
  entries: Map<string, Entry>
  tick?: Tick
}

export interface InstanceTimer {
  /** The run every timer of this job makes from now on. */
  setTick(tick: Tick): void
  /** Keep `target` running; a second call only updates what it runs with (e.g. a new project key). */
  start(target: TimerTarget): void
  stop(instanceId: string): void
  /** Run now rather than at the next tick, sharing a run already in flight. */
  runNow(instanceId: string): Promise<void>
}

/** The timers of one job; `globalKey` names it on globalThis and never changes once shipped. */
export function instanceTimer(globalKey: string, seconds: number): InstanceTimer {
  const registry = (): Registry => {
    const global = globalThis as unknown as Record<string, Registry | undefined>
    global[globalKey] ??= { entries: new Map() }
    return global[globalKey]
  }

  const run = (entry: Entry): Promise<void> => {
    if (!entry.running) {
      const tick = registry().tick
      entry.running = (tick ? tick(entry.target) : Promise.resolve())
        .catch(() => {
          // A failed run is recorded by the job itself; the next tick retries.
        })
        .finally(() => {
          entry.running = null
        })
    }
    return entry.running
  }

  return {
    setTick: (tick) => {
      registry().tick = tick
    },
    start: (target) => {
      const entries = registry().entries
      const existing = entries.get(target.instanceId)
      if (existing) {
        existing.target = target
        return
      }
      const entry: Entry = { target, running: null, timer: setInterval(() => void run(entry), seconds * 1000) }
      entry.timer.unref?.()
      entries.set(target.instanceId, entry)
    },
    stop: (instanceId) => {
      const entry = registry().entries.get(instanceId)
      if (entry) {
        clearInterval(entry.timer)
        registry().entries.delete(instanceId)
      }
    },
    runNow: (instanceId) => {
      const entry = registry().entries.get(instanceId)
      return entry ? run(entry) : Promise.resolve()
    },
  }
}
