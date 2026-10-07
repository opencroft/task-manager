// The forge read's timers: one per `tasks` instance, every FORGE_POLL_SECONDS.

import { FORGE_POLL_SECONDS } from '../../shared/forge.ts'
import { type TimerTarget, instanceTimer } from '../instance-timer.ts'

/** What a read needs to find the instance's database and project key. */
export type PollTarget = TimerTarget

// The globalThis key the timers live under. It never changes, so a timer an earlier copy of this module set keeps running the new tick.
const timer = instanceTimer('__taskPipelinesForge', FORGE_POLL_SECONDS)

export const setTick = timer.setTick
export const startPolling = timer.start
export const stopPolling = timer.stop
export const pollNow = timer.runNow
