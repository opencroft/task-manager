import { ArrowLeft, ChevronDown, ChevronUp, ExternalLink, X } from 'lucide-react'
import { createContext, type ReactNode, type Ref, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Button } from '../button'
import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../resizable'
import { Skeleton } from '../skeleton'
import { TaskManagerError } from '../states/task-manager-error'
import { cn } from 'cn'

import { type TaskType, TaskTypeIcon } from './task-type-icon'

/** Below this width of the layout itself, the peek is a full-screen sheet instead of a side panel. */
export const TASK_PEEK_SHEET_BELOW = 640

export type TaskPeekVariant = 'side' | 'sheet'

const PeekVariant = createContext<TaskPeekVariant>('side')

/** Whether the surrounding TaskPeekLayout shows the peek beside the page or as a sheet. */
export function useTaskPeekVariant(): TaskPeekVariant {
  return useContext(PeekVariant)
}

function readSize(key: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 && value < 100 ? value : null
  } catch {
    return null
  }
}

function writeSize(key: string, value: number) {
  try {
    window.localStorage.setItem(key, String(Math.round(value * 10) / 10))
  } catch {
    // Storage can be unavailable (private mode, a sandboxed frame); the size is then not remembered.
  }
}

export interface TaskPeekLayoutProps {
  /** The page. It stays mounted while the peek opens and closes, so its scroll, selection and filters are kept. */
  children: ReactNode
  /** The open peek, usually a TaskPeekPanel; null when none is open. */
  peek: ReactNode | null
  /** Remembers the peek's width in this browser under this key. */
  storageKey?: string
  /**
   * The page pane's scrolling element, for a caller that keeps or restores the
   * page's scroll position. It is the same element for as long as the layout
   * is mounted: opening and closing the peek does not replace it.
   */
  pageScrollRef?: Ref<HTMLDivElement>
  /** The page fills the pane and scrolls inside itself, so the pane never grows past its own height. */
  pageFills?: boolean
  defaultSize?: string
  minSize?: string
  maxSize?: string
  className?: string
}

/**
 * The page with a task peek beside it. At TASK_PEEK_SHEET_BELOW px of its own
 * width and above, the peek sits on the right behind a resize handle; below
 * that it is a full-screen sheet. The page pane is the scroll container in
 * both cases, so give the layout a bounded height (h-full in a bounded parent).
 * The pane's content is a flex column at least as tall as the pane, and a
 * longer page grows it. A page that fills the pane and scrolls inside itself
 * (a board, a timeline) sets `pageFills`: the content is then exactly the
 * pane's height.
 */
export function TaskPeekLayout({
  children,
  peek,
  storageKey,
  pageScrollRef,
  pageFills = false,
  defaultSize = '40%',
  minSize = '28%',
  maxSize = '70%',
  className,
}: TaskPeekLayoutProps) {
  const root = useRef<HTMLDivElement>(null)
  const [variant, setVariant] = useState<TaskPeekVariant>('side')

  useLayoutEffect(() => {
    const element = root.current
    if (!element) {
      return
    }
    const measure = () => setVariant(element.getBoundingClientRect().width < TASK_PEEK_SHEET_BELOW ? 'sheet' : 'side')
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const side = variant === 'side' && peek !== null
  const stored = storageKey ? readSize(storageKey) : null

  return (
    <PeekVariant.Provider value={variant}>
      <div ref={root} data-slot='task-peek-layout' data-peek={peek !== null ? variant : undefined} className={cn('relative h-full min-h-0 w-full', className)}>
        <ResizablePanelGroup
          orientation='horizontal'
          onLayoutChanged={(layout) => {
            const size = layout.peek
            if (storageKey && side && typeof size === 'number') {
              writeSize(storageKey, size)
            }
          }}
        >
          <ResizablePanel id='page' minSize='30%'>
            <ScrollArea ref={pageScrollRef} data-slot='task-peek-page' scrollbars='both' className='h-full' innerClassName={pageFills ? 'h-full' : 'min-h-full'}>
              {children}
            </ScrollArea>
          </ResizablePanel>
          {side ? (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel id='peek' defaultSize={stored !== null ? `${stored}%` : defaultSize} minSize={minSize} maxSize={maxSize}>
                {peek}
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
        {variant === 'sheet' && peek !== null ? peek : null}
      </div>
    </PeekVariant.Provider>
  )
}

/** Esc belongs to whatever is using it first: a field being edited, an open menu, popover or dialog. */
function escapeIsTaken(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) {
    return true
  }
  const target = event.target instanceof HTMLElement ? event.target : null
  if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) {
    return true
  }
  return document.querySelector('[role="menu"], [role="listbox"], [role="alertdialog"], [role="dialog"]:not([data-slot="task-peek-sheet"])') !== null
}

function PeekSkeleton() {
  return (
    <div role='status' aria-label='Loading the task' className='flex flex-col gap-4 p-4'>
      <Skeleton className='h-7 w-3/4' />
      <div className='flex flex-col gap-2 rounded-lg border p-3'>
        <Skeleton className='h-4 w-1/2' />
        <Skeleton className='h-4 w-2/3' />
        <Skeleton className='h-4 w-1/3' />
      </div>
      <Skeleton className='h-4 w-full' />
      <Skeleton className='h-4 w-11/12' />
      <Skeleton className='h-4 w-4/5' />
    </div>
  )
}

export interface TaskPeekPanelProps {
  taskKey: string
  type?: TaskType
  /** The task's full page. A real link, so Ctrl/Cmd-click and middle-click open it in a new tab. */
  href: string
  /** The Close button, Back on the sheet, and Esc. */
  onClose: () => void
  /** Pressing the key copies it; the host copies and confirms. Without it the key is plain text. */
  onCopyKey?: () => void
  /** Up and down buttons in the header; the page's J and K keys stay the page's own. */
  onPrevious?: () => void
  onNext?: () => void
  /** Controls before Open full page, e.g. the task's actions menu. */
  actions?: ReactNode
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  /** Side or sheet; taken from TaskPeekLayout when omitted. */
  variant?: TaskPeekVariant
  /** Sheet only: draw it inside the nearest positioned box instead of over the whole screen, e.g. in a preview. */
  inline?: boolean
  /** The task's details parts. */
  children?: ReactNode
  className?: string
}

/**
 * A task's peek: the header with its type and key, previous and next, Open
 * full page and Close (Back on a sheet), then a scrolling body for the
 * details parts. The body goes back to the top when the task changes.
 */
export function TaskPeekPanel({
  taskKey,
  type,
  href,
  onClose,
  onCopyKey,
  onPrevious,
  onNext,
  actions,
  loading = false,
  error = null,
  onRetry,
  variant,
  inline = false,
  children,
  className,
}: TaskPeekPanelProps) {
  const fromLayout = useTaskPeekVariant()
  const mode = variant ?? fromLayout
  const sheet = mode === 'sheet'
  const body = useRef<HTMLDivElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useLayoutEffect(() => {
    if (body.current) {
      body.current.scrollTop = 0
    }
  }, [taskKey])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !escapeIsTaken(event)) {
        event.preventDefault()
        close.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // A full-screen sheet takes the focus and the page's scroll while it is open, and gives both back.
  useEffect(() => {
    if (!sheet || inline) {
      return
    }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    back.current?.focus()
    return () => {
      document.body.style.overflow = overflow
      previous?.focus()
    }
  }, [sheet, inline])

  const header = (
    <div className='flex h-12 shrink-0 items-center gap-1 border-b px-2'>
      {sheet ? (
        <Button ref={back} variant='ghost' size='sm' onClick={onClose} className='-ml-1'>
          <ArrowLeft aria-hidden='true' />
          Back
        </Button>
      ) : null}
      <span className='flex min-w-0 items-center gap-2 px-1'>
        {type ? <TaskTypeIcon type={type} /> : null}
        {onCopyKey ? (
          <button
            type='button'
            onClick={onCopyKey}
            title='Copy key'
            className='truncate rounded px-1 font-mono text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50'
          >
            {taskKey}
          </button>
        ) : (
          <span className='truncate font-mono text-sm text-muted-foreground'>{taskKey}</span>
        )}
      </span>
      <span className='ml-auto flex shrink-0 items-center gap-0.5'>
        {onPrevious ? (
          <Button variant='ghost' size='icon-sm' aria-label='Previous task' title='Previous task (K)' onClick={onPrevious}>
            <ChevronUp aria-hidden='true' />
          </Button>
        ) : null}
        {onNext ? (
          <Button variant='ghost' size='icon-sm' aria-label='Next task' title='Next task (J)' onClick={onNext}>
            <ChevronDown aria-hidden='true' />
          </Button>
        ) : null}
        {actions}
        <Button variant='ghost' size='sm' render={<a href={href} />} title='Open full page' aria-label='Open full page'>
          <ExternalLink aria-hidden='true' />
          <span className='hidden @md:inline'>Open full page</span>
        </Button>
        {sheet ? null : (
          <Button variant='ghost' size='icon-sm' aria-label='Close' title='Close (Esc)' onClick={onClose}>
            <X aria-hidden='true' />
          </Button>
        )}
      </span>
    </div>
  )

  const content = loading ? (
    <PeekSkeleton />
  ) : error ? (
    <TaskManagerError title='This task could not load' message={error} onRetry={onRetry} />
  ) : (
    children
  )

  const frame = (
    <div
      role={sheet ? 'dialog' : 'region'}
      aria-modal={sheet && !inline ? true : undefined}
      aria-label={`Task ${taskKey}`}
      data-slot={sheet ? 'task-peek-sheet' : 'task-peek-panel'}
      className={cn(
        '@container flex min-h-0 flex-col bg-background text-foreground',
        sheet ? (inline ? 'absolute inset-0 z-20' : 'fixed inset-0 z-50 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]') : 'h-full',
        className,
      )}
    >
      {header}
      <ScrollArea ref={body} className='flex-1' viewportClassName='overscroll-contain'>
        {content}
      </ScrollArea>
    </div>
  )

  return sheet && !inline ? createPortal(frame, document.body) : frame
}
