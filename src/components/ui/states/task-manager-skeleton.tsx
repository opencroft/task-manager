import type { ReactElement } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export type TaskManagerSkeletonPage = 'tasks' | 'board' | 'timeline' | 'workflows' | 'details'

export interface TaskManagerSkeletonProps {
  /** Which page is loading; the placeholder takes that page's shape. */
  page: TaskManagerSkeletonPage
  className?: string
}

const LABEL: Record<TaskManagerSkeletonPage, string> = {
  tasks: 'Loading tasks',
  board: 'Loading the board',
  timeline: 'Loading the timeline',
  workflows: 'Loading workflows',
  details: 'Loading the task',
}

// Fixed, uneven widths: a skeleton reads as text only if its lines differ.
const SUMMARY = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/6', 'w-2/5', 'w-3/5', 'w-1/2', 'w-4/5']
const CARDS_PER_COLUMN = [3, 2, 4, 1]
const TREE = ['pl-0', 'pl-4', 'pl-4', 'pl-8', 'pl-0', 'pl-4', 'pl-0', 'pl-4']
const BAR = ['ml-[4%] w-[30%]', 'ml-[10%] w-[18%]', 'ml-[28%] w-[22%]', 'ml-[30%] w-[12%]', 'ml-[46%] w-[34%]', 'ml-[50%] w-[16%]', '', 'ml-[62%] w-[26%]']

function TasksShape() {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex items-center gap-2'>
        <Skeleton className='h-8 w-full max-w-64' />
        <Skeleton className='hidden h-8 w-20 sm:block' />
        <Skeleton className='hidden h-8 w-20 sm:block' />
        <Skeleton className='hidden h-8 w-20 md:block' />
      </div>
      <div className='flex flex-col divide-y rounded-md border'>
        {SUMMARY.map((width, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
          <div key={index} className='flex h-11 items-center gap-3 px-3'>
            <Skeleton className='size-4 shrink-0 rounded-[4px]' />
            <Skeleton className='h-3 w-14 shrink-0' />
            <div className='min-w-0 flex-1'>
              <Skeleton className={cn('h-3.5', width)} />
            </div>
            <Skeleton className='hidden h-5 w-20 shrink-0 rounded-md sm:block' />
            <Skeleton className='hidden h-3 w-14 shrink-0 md:block' />
            <span className='hidden shrink-0 items-center gap-2 sm:flex'>
              <Skeleton className='size-5 rounded-full' />
              <Skeleton className='h-3 w-16' />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function BoardShape() {
  return (
    <div className='flex gap-3 overflow-hidden'>
      {CARDS_PER_COLUMN.map((cards, column) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder columns
        <div key={column} className='flex w-72 max-w-[calc(100vw-2rem)] shrink-0 flex-col gap-2 rounded-xl bg-muted/60 p-2'>
          <div className='flex h-7 items-center gap-2 px-0.5'>
            <Skeleton className='h-5 w-24 rounded-md' />
            <Skeleton className='h-3 w-4' />
          </div>
          {Array.from({ length: cards }, (_, card) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder cards
            <div key={card} className='flex flex-col gap-2.5 rounded-lg border bg-card p-3'>
              <Skeleton className={cn('h-3.5', SUMMARY[(column * 3 + card) % SUMMARY.length])} />
              <Skeleton className='h-3.5 w-1/3' />
              <div className='flex items-center gap-2'>
                <Skeleton className='size-4 rounded-[4px]' />
                <Skeleton className='h-3 w-14' />
                <Skeleton className='ml-auto size-5 rounded-full' />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function TimelineShape() {
  return (
    <div className='flex flex-col gap-4'>
      <div className='grid grid-cols-[8rem_minmax(0,1fr)] overflow-hidden rounded-md border sm:grid-cols-[16rem_minmax(0,1fr)]'>
        <div className='flex h-8 items-center border-r border-b px-3'>
          <Skeleton className='h-3 w-16' />
        </div>
        <div className='flex h-8 items-center justify-between gap-4 border-b px-3'>
          {Array.from({ length: 6 }, (_, tick) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder ticks
            <Skeleton key={tick} className='h-3 w-8' />
          ))}
        </div>
        {TREE.map((indent, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
          <div key={row} className='contents'>
            <div className={cn('flex h-9 items-center gap-2 border-r pr-3', indent, 'ml-3')}>
              <Skeleton className='size-4 shrink-0 rounded-[4px]' />
              <Skeleton className={cn('h-3', SUMMARY[row])} />
            </div>
            <div className='flex h-9 items-center'>
              {BAR[row] ? <Skeleton className={cn('h-5 rounded-md', BAR[row])} /> : null}
            </div>
          </div>
        ))}
      </div>
      <div className='flex flex-col gap-2'>
        <Skeleton className='h-4 w-20' />
        <div className='flex flex-col divide-y rounded-md border'>
          {SUMMARY.slice(0, 3).map((width, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
            <div key={index} className='flex h-9 items-center gap-2 px-3'>
              <Skeleton className='size-4 shrink-0 rounded-[4px]' />
              <Skeleton className={cn('h-3', width)} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function WorkflowsShape() {
  return (
    <div className='flex flex-col gap-4 md:flex-row md:gap-6'>
      <div className='flex shrink-0 flex-col gap-2 md:w-60'>
        <div className='flex items-center justify-between'>
          <Skeleton className='h-4 w-20' />
          <Skeleton className='h-8 w-16' />
        </div>
        {['w-28', 'w-36', 'w-24'].map((width) => (
          <div key={width} className='flex flex-col gap-1.5 rounded-md px-3 py-2'>
            <Skeleton className={cn('h-3.5', width)} />
            <Skeleton className='h-3 w-12' />
          </div>
        ))}
      </div>
      <div className='flex min-w-0 flex-1 flex-col gap-4'>
        <div className='flex items-center gap-4 border-b pb-2'>
          <Skeleton className='h-4 w-12' />
          <Skeleton className='h-4 w-12' />
          <Skeleton className='ml-auto h-8 w-16' />
        </div>
        <Skeleton className='h-9 w-full' />
        <Skeleton className='h-14 w-full' />
        {[0, 1].map((card) => (
          <div key={card} className='flex flex-col gap-4 rounded-lg border p-4'>
            <div className='flex items-center gap-3'>
              <Skeleton className='size-6 shrink-0 rounded-full' />
              <Skeleton className='h-9 flex-1' />
            </div>
            <div className='grid gap-4 sm:grid-cols-3'>
              <Skeleton className='h-9' />
              <Skeleton className='h-9' />
              <Skeleton className='h-9' />
            </div>
            <Skeleton className='h-20 w-full' />
          </div>
        ))}
      </div>
    </div>
  )
}

function DetailsShape() {
  return (
    <div className='flex flex-col gap-4'>
      <Skeleton className='h-3 w-40' />
      <div className='flex flex-col gap-2'>
        <Skeleton className='h-3 w-16' />
        <Skeleton className='h-7 w-2/3' />
      </div>
      <div className='grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]'>
        <div className='order-2 flex min-w-0 flex-col gap-6 lg:order-none'>
          <div className='flex flex-col gap-2'>
            <Skeleton className='h-3.5 w-full' />
            <Skeleton className='h-3.5 w-11/12' />
            <Skeleton className='h-3.5 w-3/5' />
          </div>
          <div className='flex flex-col gap-2'>
            <Skeleton className='h-4 w-20' />
            <Skeleton className='h-24 w-full' />
          </div>
          <div className='flex flex-col gap-2'>
            <Skeleton className='h-4 w-24' />
            <Skeleton className='h-16 w-full' />
          </div>
        </div>
        <div className='order-1 flex flex-col gap-3 rounded-lg border p-3 lg:order-none'>
          {['w-20', 'w-28', 'w-16', 'w-24', 'w-14', 'w-32'].map((width) => (
            <div key={width} className='flex items-center justify-between gap-3'>
              <Skeleton className='h-3 w-16' />
              <Skeleton className={cn('h-5', width)} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const SHAPE: Record<TaskManagerSkeletonPage, () => ReactElement> = {
  tasks: TasksShape,
  board: BoardShape,
  timeline: TimelineShape,
  workflows: WorkflowsShape,
  details: DetailsShape,
}

/**
 * What a page shows while its data loads: grey placeholders in that page's
 * shape, so the layout does not jump when the content arrives. Announced to
 * screen readers as loading.
 */
export function TaskManagerSkeleton({ page, className }: TaskManagerSkeletonProps) {
  const Shape = SHAPE[page]
  return (
    <div data-slot='task-manager-skeleton' data-page={page} role='status' aria-busy='true' aria-label={LABEL[page]} className={cn('w-full min-w-0', className)}>
      <span className='sr-only'>{LABEL[page]}…</span>
      <Shape />
    </div>
  )
}
