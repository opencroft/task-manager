import { ChevronLeft, ChevronRight, Download, ImageOff, Loader2, X } from 'lucide-react'
import { type KeyboardEvent, type PointerEvent, type ReactElement, useRef, useState } from 'react'

import { Button } from '../button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../dialog'
import { cn } from '@/lib/utils'

/** What the viewer needs of an attachment. A task attachment has all of it. */
export interface TaskAttachmentViewerItem {
  id: string
  name: string
  /** The download, served as an attachment; null while the host has not made it yet. */
  url?: string | null
  /** Set by the server, and only for images it serves for inline display. Nothing else is ever shown here. */
  previewable?: boolean
  /** The inline image; null while it loads. */
  previewUrl?: string | null
  size?: number
}

/** Bytes as people read them: 812 B, 14 KB, 2.4 MB. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${Math.max(0, Math.round(bytes || 0))} B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

/**
 * How a Download control behaves: a press that calls onDownload when the host
 * gives one (it may need to fetch first), else a link to the file with
 * `download`, else disabled while there is neither.
 */
export function attachmentDownloadProps<T extends TaskAttachmentViewerItem>(
  item: T,
  onDownload?: (item: T) => void,
): { render?: ReactElement; onClick?: () => void; disabled?: boolean } {
  if (onDownload) {
    return { onClick: () => onDownload(item) }
  }
  if (item.url) {
    return { render: <a href={item.url} download={item.name} /> }
  }
  return { disabled: true }
}

export interface TaskAttachmentViewerProps<T extends TaskAttachmentViewerItem = TaskAttachmentViewerItem> {
  /** The task's attachments, in their shown order. Only the previewable ones are viewable. */
  items: T[]
  /** The attachment on screen; null when the viewer is closed. */
  openId: string | null
  /** Called with the next or previous id as the viewer moves, and with null when it closes. */
  onOpenChange: (id: string | null) => void
  /** Download through the host. Without it, Download is a link to `url`. */
  onDownload?: (item: T) => void
  /** Draw inside the nearest positioned box instead of over the whole screen, e.g. in a preview. */
  inline?: boolean
  className?: string
}

/**
 * A task's images full screen, one at a time: fitted to the window on a dark
 * backdrop, with previous and next (buttons, the arrow keys or a swipe),
 * Download, and Esc or × to close. Only items the server marked previewable
 * are shown or stepped through, so an SVG or any other file is never rendered
 * here, whatever its type.
 */
export function TaskAttachmentViewer<T extends TaskAttachmentViewerItem>({ items, openId, onOpenChange, onDownload, inline = false, className }: TaskAttachmentViewerProps<T>) {
  const images = items.filter((item) => item.previewable === true)
  const index = openId === null ? -1 : images.findIndex((item) => item.id === openId)
  const current = index >= 0 ? images[index] : null

  const go = (step: number) => {
    const next = images[index + step]
    if (next) {
      onOpenChange(next.id)
    }
  }

  const frame = current ? (
    <ViewerFrame
      image={current}
      index={index}
      total={images.length}
      onStep={go}
      onClose={() => onOpenChange(null)}
      download={attachmentDownloadProps(current, onDownload)}
      inline={inline}
    />
  ) : null

  if (inline) {
    return current ? (
      <div role='dialog' aria-label={current.name} data-slot='task-attachment-viewer' className={cn('absolute inset-0 z-20', className)}>
        {frame}
      </div>
    ) : null
  }

  return (
    <Dialog
      open={current !== null}
      onOpenChange={(next) => {
        if (!next) {
          onOpenChange(null)
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-slot='task-attachment-viewer'
        className={cn('inset-0 top-0 left-0 block h-dvh w-full max-w-none translate-x-0 translate-y-0 rounded-none bg-transparent p-0 ring-0 sm:max-w-none', className)}
      >
        {frame}
      </DialogContent>
    </Dialog>
  )
}

interface ViewerFrameProps {
  image: TaskAttachmentViewerItem
  index: number
  total: number
  onStep: (step: number) => void
  onClose: () => void
  download: ReturnType<typeof attachmentDownloadProps>
  inline: boolean
}

function ViewerFrame({ image, index, total, onStep, onClose, download, inline }: ViewerFrameProps) {
  // Tied to the image's source, so loading and failure start over on every step and when a blob arrives.
  const source = image.previewUrl ?? null
  const [state, setState] = useState<{ source: string | null; status: 'loaded' | 'failed' } | null>(null)
  const status = source === null ? 'loading' : state?.source === source ? state.status : 'loading'
  const swipe = useRef<{ x: number; y: number } | null>(null)
  const hasPrevious = index > 0
  const hasNext = index < total - 1

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' && hasPrevious) {
      event.preventDefault()
      onStep(-1)
    } else if (event.key === 'ArrowRight' && hasNext) {
      event.preventDefault()
      onStep(1)
    } else if (event.key === 'Escape' && inline) {
      event.preventDefault()
      onClose()
    }
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    swipe.current = event.pointerType === 'mouse' ? null : { x: event.clientX, y: event.clientY }
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = swipe.current
    swipe.current = null
    if (!start) {
      return
    }
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    // A mostly sideways swipe of 48 px steps; anything else is left alone.
    if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0 && hasNext) {
        onStep(1)
      } else if (dx > 0 && hasPrevious) {
        onStep(-1)
      }
    }
  }

  const place = `${total > 1 ? `${index + 1} of ${total}` : 'Image'}${image.size !== undefined ? ` · ${formatFileSize(image.size)}` : ''}`
  const control = 'text-white hover:bg-white/15 hover:text-white focus-visible:ring-white/50 disabled:opacity-30'

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys and swipes step through the images; the buttons do the same for everyone else.
    <div
      className='flex h-full flex-col bg-black/90 text-white outline-none'
      onKeyDown={onKeyDown}
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className='flex h-12 shrink-0 items-center gap-2 px-2'>
        <div className='flex min-w-0 flex-1 flex-col px-1'>
          {inline ? (
            <h2 className='truncate text-sm font-medium leading-tight'>{image.name}</h2>
          ) : (
            <DialogTitle className='truncate text-sm font-medium leading-tight'>{image.name}</DialogTitle>
          )}
          {inline ? (
            <p className='truncate text-xs leading-tight text-white/70 tabular-nums'>{place}</p>
          ) : (
            <DialogDescription className='truncate text-xs leading-tight text-white/70 tabular-nums'>{place}</DialogDescription>
          )}
        </div>
        <Button variant='ghost' size='sm' className={control} aria-label={`Download ${image.name}`} {...download}>
          <Download aria-hidden='true' />
          <span className='hidden sm:inline'>Download</span>
        </Button>
        <Button variant='ghost' size='icon-sm' className={control} aria-label='Close' title='Close (Esc)' onClick={onClose}>
          <X aria-hidden='true' />
        </Button>
      </div>
      <div
        className='relative flex min-h-0 flex-1 items-center justify-center px-2 pb-2 sm:px-14'
        style={{ touchAction: 'pan-y pinch-zoom' }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          swipe.current = null
        }}
      >
        {status === 'failed' ? (
          <div role='alert' className='flex max-w-xs flex-col items-center gap-3 text-center'>
            <ImageOff aria-hidden='true' className='size-8 text-white/70' />
            <p className='text-sm'>This image could not be shown.</p>
            <Button variant='outline' size='sm' className='border-white/30 bg-transparent text-white hover:bg-white/15 hover:text-white' {...download}>
              <Download aria-hidden='true' />
              Download it instead
            </Button>
          </div>
        ) : source !== null ? (
          <img
            key={source}
            src={source}
            alt={image.name}
            draggable={false}
            onLoad={() => setState({ source, status: 'loaded' })}
            onError={() => setState({ source, status: 'failed' })}
            className={cn('max-h-full max-w-full select-none object-contain transition-opacity', status === 'loaded' ? 'opacity-100' : 'opacity-0')}
          />
        ) : null}
        {status === 'loading' ? (
          <span role='status' aria-label='Loading the image' className='absolute inset-0 flex items-center justify-center'>
            <Loader2 aria-hidden='true' className='size-6 animate-spin text-white/70' />
          </span>
        ) : null}
        {total > 1 ? (
          <>
            <Button variant='ghost' size='icon' className={cn(control, 'absolute top-1/2 left-2 -translate-y-1/2 rounded-full bg-black/40')} aria-label='Previous image' title='Previous (←)' disabled={!hasPrevious} onClick={() => onStep(-1)}>
              <ChevronLeft aria-hidden='true' />
            </Button>
            <Button variant='ghost' size='icon' className={cn(control, 'absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-black/40')} aria-label='Next image' title='Next (→)' disabled={!hasNext} onClick={() => onStep(1)}>
              <ChevronRight aria-hidden='true' />
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}
