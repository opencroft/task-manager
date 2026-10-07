import { Bot, CircleAlert, Download, Eye, File as FileIcon, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, ImageOff, Loader2, MoreHorizontal, Paperclip, Pencil, RotateCcw, Trash2, Upload, X } from 'lucide-react'
import {
  createContext,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { Button } from '../button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../dialog'
import { Input } from '../input'
import { Skeleton } from '../skeleton'
import { TaskManagerError } from '../states/task-manager-error'
import { cn } from '@/lib/utils'

import { ItemActionsMenu, ItemContextMenu, type ItemMenuEntries } from './item-menu'
import { attachmentDownloadProps, formatFileSize, TaskAttachmentViewer } from './task-attachment-viewer'

/** The server's per-file limit until the host passes its own: 25 MB. */
export const TASK_ATTACHMENT_MAX_SIZE = 25 * 1024 * 1024

export interface TaskAttachment {
  id: string
  name: string
  /** Bytes. */
  size: number
  /** The safe type the server decided. Picks the file icon; never decides what is shown inline. */
  contentType: string
  createdAt: string
  uploader: { kind: 'agent' | 'person'; name: string }
  /** The download, served as an attachment; null while the host has not made it yet. */
  url: string | null
  /** Set by the server, and only for images it serves inline. Previewable files are thumbnails; everything else is a row. */
  previewable: boolean
  /** The inline image; null while the host fetches it (the thumbnail keeps its box meanwhile). */
  previewUrl?: string | null
  width?: number
  height?: number
}

/** A file on its way up. Host state: the host adds it on onUpload and drops it once the attachment exists. */
export interface TaskAttachmentUpload {
  id: string
  name: string
  size: number
  /** 0 to 1; null while the progress is unknown. */
  progress: number | null
  /** Why the upload failed, in the server's words. */
  error?: string | null
}

// ---------------------------------------------------------------------------
// Dropping and pasting
// ---------------------------------------------------------------------------

type Receiver = (files: File[]) => void

const DropTarget = createContext<{ register: (receiver: Receiver | null) => void } | null>(null)

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

/** Drag-and-drop of files onto an element, with a flag while files are over it. */
function useFileDrop(onFiles: Receiver, enabled: boolean) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!enabled || !carriesFiles(event)) {
        return
      }
      event.preventDefault()
      depth.current += 1
      setOver(true)
    },
    onDragOver: (event: DragEvent) => {
      if (!enabled || !carriesFiles(event)) {
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (event: DragEvent) => {
      if (!enabled || !carriesFiles(event)) {
        return
      }
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) {
        setOver(false)
      }
    },
    onDrop: (event: DragEvent) => {
      if (!enabled || !carriesFiles(event)) {
        return
      }
      event.preventDefault()
      depth.current = 0
      setOver(false)
      const files = Array.from(event.dataTransfer.files)
      if (files.length > 0) {
        onFiles(files)
      }
    },
  }
  return { over: enabled && over, handlers }
}

/** A pasted screenshot arrives as "image.png"; give it a name that says when it was taken. */
function namePasted(file: File, now: Date): File {
  if (file.name && !/^image\.[a-z0-9]+$/i.test(file.name)) {
    return file
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const extension = file.type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
  return new File([file], `pasted-${stamp}.${extension}`, { type: file.type })
}

export interface TaskAttachmentDropZoneProps {
  /** The whole task: its page or its peek. The TaskAttachments inside it receives what is dropped or pasted. */
  children: ReactNode
  /** Names the target in the overlay, e.g. the task's key. */
  label?: string
  className?: string
}

/**
 * Makes the whole task a place to drop files, with a "Drop to attach" overlay
 * while files are dragged over it, and takes an image pasted anywhere on the
 * task except into a field (so a comment composer keeps its own paste). What
 * arrives goes to the TaskAttachments inside, which applies the size limit
 * and uploads the rest.
 */
export function TaskAttachmentDropZone({ children, label, className }: TaskAttachmentDropZoneProps) {
  const root = useRef<HTMLDivElement>(null)
  const receiver = useRef<Receiver | null>(null)
  const [receiving, setReceiving] = useState(false)
  const register = useCallback((next: Receiver | null) => {
    receiver.current = next
    setReceiving(next !== null)
  }, [])
  const context = useMemo(() => ({ register }), [register])
  const { over, handlers } = useFileDrop((files) => receiver.current?.(files), receiving)

  useEffect(() => {
    if (!receiving) {
      return
    }
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) {
        return
      }
      // Only a paste aimed at this task: focus inside it, or on nothing in particular.
      if (target && target !== document.body && !root.current?.contains(target)) {
        return
      }
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length === 0) {
        return
      }
      event.preventDefault()
      const now = new Date()
      receiver.current?.(files.map((file) => namePasted(file, now)))
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [receiving])

  return (
    <DropTarget.Provider value={context}>
      <div ref={root} data-slot='task-attachment-drop-zone' className={cn('relative', className)} {...handlers}>
        {children}
        {over ? <DropOverlay label={label} /> : null}
      </div>
    </DropTarget.Provider>
  )
}

function DropOverlay({ label }: { label?: string }) {
  return (
    <div aria-hidden='true' className='pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/85 p-4 backdrop-blur-sm'>
      <div className='flex flex-col items-center gap-2 text-center'>
        <Upload className='size-6 text-primary' />
        <p className='text-sm font-medium'>{label ? `Drop to attach to ${label}` : 'Drop to attach'}</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * A refused file's size, rounded up to one decimal so it never reads as
 * fitting the limit: 10.05 MB against 10 MB is "10.1 MB", not "10 MB".
 */
function formatRefusedSize(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.ceil(bytes)} B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  let rounded = Math.ceil(value * 10) / 10
  // 1023.99 MB rounds up to 1024 MB, which is 1 GB.
  if (rounded >= 1024 && unit < units.length - 1) {
    rounded = Math.ceil((rounded / 1024) * 10) / 10
    unit += 1
  }
  return `${rounded} ${units[unit]}`
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** A refusal's own words, without the transport's error-class prefix. */
function messageOf(caught: unknown, fallback: string): string {
  const raw = caught instanceof Error ? caught.message : String(caught)
  return raw.replace(/^[A-Za-z]*Error:\s*/, '') || fallback
}

function FileTypeIcon({ attachment, className }: { attachment: TaskAttachment; className?: string }) {
  const type = attachment.contentType.toLowerCase()
  const extension = attachment.name.includes('.') ? attachment.name.split('.').pop()?.toLowerCase() ?? '' : ''
  const Icon = type.startsWith('image/')
    ? FileImage
    : /zip|tar|gzip|compressed|archive/.test(type) || ['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(extension)
      ? FileArchive
      : /spreadsheet|excel|csv/.test(type) || ['csv', 'xls', 'xlsx', 'ods'].includes(extension)
        ? FileSpreadsheet
        : /json|javascript|typescript|xml|x-sh|x-python/.test(type) || ['json', 'js', 'ts', 'tsx', 'py', 'sh', 'yml', 'yaml', 'xml', 'sql', 'log'].includes(extension)
          ? FileCode
          : type.startsWith('text/') || /pdf|document|msword|rtf/.test(type) || ['md', 'txt', 'pdf', 'doc', 'docx', 'rtf'].includes(extension)
            ? FileText
            : FileIcon
  return <Icon aria-hidden='true' className={cn('size-4 shrink-0 text-muted-foreground', className)} />
}

function Uploader({ uploader }: { uploader: TaskAttachment['uploader'] }) {
  return (
    <span className='inline-flex min-w-0 items-center gap-1'>
      {uploader.kind === 'agent' ? <Bot aria-label='Agent' className='size-3 shrink-0' /> : null}
      <span className='truncate'>{uploader.name}</span>
    </span>
  )
}

interface RenameFieldProps {
  name: string
  onCommit: (next: string) => void
  onCancel: () => void
  className?: string
}

/** The name in an input: Enter or leaving saves, Esc puts it back. The part before the extension starts selected. */
function RenameField({ name, onCommit, onCancel, className }: RenameFieldProps) {
  const [value, setValue] = useState(name)
  const done = useRef(false)
  const finish = (commit: boolean) => {
    if (done.current) {
      return
    }
    done.current = true
    const next = value.trim()
    if (commit && next && next !== name) {
      onCommit(next)
    } else {
      onCancel()
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    }
  }
  return (
    <Input
      // biome-ignore lint/a11y/noAutofocus: the field appears because Rename was just chosen.
      autoFocus
      value={value}
      aria-label={`New name for ${name}`}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      onFocus={(event) => {
        const dot = name.lastIndexOf('.')
        event.currentTarget.setSelectionRange(0, dot > 0 ? dot : name.length)
      }}
      className={cn('h-7 min-w-0 px-2 text-sm', className)}
    />
  )
}

interface ActionsMenuProps {
  attachment: TaskAttachment
  onView?: () => void
  onDownload: () => void
  canDownload: boolean
  onRename?: () => void
  onDelete?: () => void
  disabled?: boolean
  className?: string
}

/** An attachment's actions, one list for its … button and its context menu. Delete asks first. */
function attachmentEntries({ onView, onDownload, canDownload, onRename, onDelete, disabled }: Omit<ActionsMenuProps, 'attachment' | 'className'>): ItemMenuEntries {
  if (disabled) {
    return []
  }
  return [
    onView && { id: 'view', label: 'View', icon: Eye, group: 'open', onSelect: onView },
    { id: 'download', label: 'Download', icon: Download, group: 'open', disabled: !canDownload, onSelect: onDownload },
    onRename && { id: 'rename', label: 'Rename', icon: Pencil, onSelect: onRename },
    onDelete && { id: 'delete', label: 'Delete…', icon: Trash2, destructive: true, onSelect: onDelete },
  ]
}

function ActionsMenu({ attachment, className, ...actions }: ActionsMenuProps) {
  const label = `Actions for ${attachment.name}`
  // While a rename or delete is in flight the button stays, disabled.
  return actions.disabled ? (
    <Button variant='ghost' size='icon-sm' aria-label={label} disabled className={className}>
      <MoreHorizontal aria-hidden='true' />
    </Button>
  ) : (
    <ItemActionsMenu entries={attachmentEntries(actions)} label={label} className={className} />
  )
}

function Problem({ children, onRetry, retryLabel = 'Retry', onDismiss, dismissLabel }: { children: ReactNode; onRetry?: () => void; retryLabel?: string; onDismiss?: () => void; dismissLabel: string }) {
  return (
    <div role='alert' className='flex min-w-0 items-start gap-1.5 text-xs text-destructive'>
      <CircleAlert aria-hidden='true' className='mt-0.5 size-3.5 shrink-0' />
      <p className='min-w-0 flex-1 break-words'>{children}</p>
      {onRetry ? (
        <Button variant='ghost' size='xs' className='-my-0.5 h-5 px-1.5' onClick={onRetry}>
          <RotateCcw aria-hidden='true' />
          {retryLabel}
        </Button>
      ) : null}
      {onDismiss ? (
        <Button variant='ghost' size='icon-xs' className='-my-0.5 size-5' aria-label={dismissLabel} onClick={onDismiss}>
          <X aria-hidden='true' />
        </Button>
      ) : null}
    </div>
  )
}

function ProgressBar({ progress, label }: { progress: number | null; label: string }) {
  const percent = progress === null ? null : Math.round(Math.min(1, Math.max(0, progress)) * 100)
  return (
    <div
      role='progressbar'
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className='h-1 w-full overflow-hidden rounded-full bg-muted'
    >
      <div className={cn('h-full rounded-full bg-primary transition-[width]', percent === null && 'w-1/3 animate-pulse')} style={percent === null ? undefined : { width: `${percent}%` }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export interface TaskAttachmentsProps {
  attachments: TaskAttachment[]
  /** Files on their way up, oldest first. */
  uploads?: TaskAttachmentUpload[]
  /** The per-file limit in bytes; a larger file is refused in place and never reaches onUpload. Pass the server's own. */
  maxSize?: number
  /** Uploads picked, dropped or pasted files that fit the limit. Without it the section is read-only. */
  onUpload?: (files: File[]) => void
  onRetryUpload?: (id: string) => void
  onDismissUpload?: (id: string) => void
  /** Renames an attachment; the row shows it pending and a rejection's message in place. */
  onRename?: (id: string, name: string) => Promise<unknown> | unknown
  /** Deletes an attachment, after the confirm; the row shows it pending and a rejection's message in place. */
  onDelete?: (id: string) => Promise<unknown> | unknown
  /** Download through the host (it may need to fetch first). Without it, Download is a link to `url`. */
  onDownload?: (attachment: TaskAttachment) => void
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  className?: string
}

type Busy = { kind: 'rename' | 'delete' }

function saveThroughLink(attachment: TaskAttachment) {
  if (!attachment.url) {
    return
  }
  const link = document.createElement('a')
  link.href = attachment.url
  link.download = attachment.name
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

/**
 * A task's attachments. Previewable images are a grid of thumbnails that open
 * the viewer; everything else is a row with its type icon, size, uploader and
 * time. Uploads show their progress, and a failed one keeps its row with the
 * reason and Retry. Files come from the Attach button, a drop on this section
 * or, inside a TaskAttachmentDropZone, a drop or paste anywhere on the task.
 * Files over maxSize are refused in place with the limit.
 */
export function TaskAttachments({
  attachments,
  uploads = [],
  maxSize = TASK_ATTACHMENT_MAX_SIZE,
  onUpload,
  onRetryUpload,
  onDismissUpload,
  onRename,
  onDelete,
  onDownload,
  loading = false,
  error = null,
  onRetry,
  className,
}: TaskAttachmentsProps) {
  const section = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const refusalKey = useRef(0)
  const [refused, setRefused] = useState<{ key: number; name: string; size: number }[]>([])
  const [viewing, setViewing] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<TaskAttachment | null>(null)
  const [busy, setBusy] = useState<Record<string, Busy>>({})
  const [failures, setFailures] = useState<Record<string, string>>({})

  const accept = (files: File[]) => {
    if (!onUpload) {
      return
    }
    const fits = files.filter((file) => file.size <= maxSize)
    const over = files.filter((file) => file.size > maxSize)
    if (over.length > 0) {
      setRefused((current) => [...current, ...over.map((file) => ({ key: ++refusalKey.current, name: file.name, size: file.size }))])
    }
    if (fits.length > 0) {
      onUpload(fits)
    }
    // A drop far up the task still shows where the files went.
    section.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }
  const latest = useRef(accept)
  latest.current = accept

  const zone = useContext(DropTarget)
  const canUpload = Boolean(onUpload)
  useEffect(() => {
    if (!zone || !canUpload) {
      return
    }
    zone.register((files) => latest.current(files))
    return () => zone.register(null)
  }, [zone, canUpload])
  // Standalone, the section itself takes drops; inside a drop zone the zone does.
  const { over, handlers } = useFileDrop((files) => latest.current(files), canUpload && !zone)

  const setBusyFor = (id: string, value: Busy | null) =>
    setBusy((current) => {
      const next = { ...current }
      if (value) {
        next[id] = value
      } else {
        delete next[id]
      }
      return next
    })
  const setFailureFor = (id: string, value: string | null) =>
    setFailures((current) => {
      const next = { ...current }
      if (value) {
        next[id] = value
      } else {
        delete next[id]
      }
      return next
    })

  const rename = async (id: string, name: string) => {
    setRenaming(null)
    if (!onRename) {
      return
    }
    setBusyFor(id, { kind: 'rename' })
    setFailureFor(id, null)
    try {
      await onRename(id, name)
    } catch (caught) {
      setFailureFor(id, messageOf(caught, 'Could not rename the file'))
    } finally {
      setBusyFor(id, null)
    }
  }

  const remove = async (attachment: TaskAttachment) => {
    setConfirming(null)
    if (!onDelete) {
      return
    }
    setBusyFor(attachment.id, { kind: 'delete' })
    setFailureFor(attachment.id, null)
    try {
      await onDelete(attachment.id)
    } catch (caught) {
      setFailureFor(attachment.id, messageOf(caught, 'Could not delete the file'))
    } finally {
      setBusyFor(attachment.id, null)
    }
  }

  const download = (attachment: TaskAttachment) => (onDownload ? onDownload(attachment) : saveThroughLink(attachment))
  const canDownload = (attachment: TaskAttachment) => Boolean(onDownload || attachment.url)

  if (loading) {
    return (
      <div role='status' aria-label='Loading the attachments' className={cn('flex flex-col gap-3', className)}>
        <div className='grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-2'>
          <Skeleton className='aspect-square' />
          <Skeleton className='aspect-square' />
        </div>
        <Skeleton className='h-9 w-full' />
        <Skeleton className='h-9 w-4/5' />
      </div>
    )
  }
  if (error) {
    return <TaskManagerError variant='inline' title='The attachments could not load' message={error} onRetry={onRetry} className={className} />
  }

  const images = attachments.filter((attachment) => attachment.previewable)
  const files = attachments.filter((attachment) => !attachment.previewable)
  const empty = attachments.length === 0 && uploads.length === 0 && refused.length === 0
  const limit = formatFileSize(maxSize)

  const pickButton = onUpload ? (
    <>
      <input
        ref={picker}
        type='file'
        multiple
        hidden
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (picked.length > 0) {
            accept(picked)
          }
        }}
      />
      <Button variant='outline' size='sm' onClick={() => picker.current?.click()}>
        <Paperclip aria-hidden='true' />
        Attach files
      </Button>
    </>
  ) : null

  return (
    <div ref={section} data-slot='task-attachments' className={cn('relative flex min-w-0 flex-col gap-3', className)} {...handlers}>
      {empty ? (
        <div className='flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center'>
          <Paperclip aria-hidden='true' className='size-5 text-muted-foreground' />
          <p className='text-sm text-muted-foreground'>{onUpload ? 'No attachments yet. Drop files here or paste an image.' : 'No attachments.'}</p>
          {pickButton}
        </div>
      ) : null}

      {images.length > 0 ? (
        <ul aria-label='Images' className='grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-2'>
          {images.map((image) => {
            const state = busy[image.id]
            return (
              <ItemContextMenu
                key={image.id}
                entries={attachmentEntries({
                  onView: () => setViewing(image.id),
                  onDownload: () => download(image),
                  canDownload: canDownload(image),
                  onRename: onRename ? () => setRenaming(image.id) : undefined,
                  onDelete: onDelete ? () => setConfirming(image) : undefined,
                  disabled: Boolean(state) || renaming === image.id,
                })}
                render={<li />}
                className={cn('flex min-w-0 flex-col gap-1', state?.kind === 'delete' && 'opacity-60')}
              >
                <div className='relative'>
                  <button
                    type='button'
                    onClick={() => setViewing(image.id)}
                    title={image.name}
                    aria-label={`View ${image.name}, ${formatFileSize(image.size)}, added by ${image.uploader.name}`}
                    className='block aspect-square w-full overflow-hidden rounded-md border bg-muted outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'
                  >
                    <Thumbnail image={image} />
                  </button>
                  <ActionsMenu
                    attachment={image}
                    onView={() => setViewing(image.id)}
                    onDownload={() => download(image)}
                    canDownload={canDownload(image)}
                    onRename={onRename ? () => setRenaming(image.id) : undefined}
                    onDelete={onDelete ? () => setConfirming(image) : undefined}
                    disabled={Boolean(state)}
                    className='absolute top-1 right-1 bg-background/85 shadow-xs backdrop-blur-sm hover:bg-background'
                  />
                  {state ? (
                    <span className='absolute bottom-1 left-1 flex size-6 items-center justify-center rounded-md bg-background/85'>
                      <Loader2 aria-label={state.kind === 'delete' ? 'Deleting' : 'Renaming'} className='size-3.5 animate-spin' />
                    </span>
                  ) : null}
                </div>
                {renaming === image.id ? (
                  <RenameField name={image.name} onCommit={(next) => void rename(image.id, next)} onCancel={() => setRenaming(null)} />
                ) : (
                  <span className='truncate text-xs text-muted-foreground' title={image.name}>
                    {image.name}
                  </span>
                )}
                {failures[image.id] ? (
                  <Problem onDismiss={() => setFailureFor(image.id, null)} dismissLabel='Dismiss'>
                    {failures[image.id]}
                  </Problem>
                ) : null}
              </ItemContextMenu>
            )
          })}
        </ul>
      ) : null}

      {files.length > 0 || uploads.length > 0 || refused.length > 0 ? (
        <ul aria-label='Files' className='flex flex-col divide-y rounded-lg border'>
          {files.map((file) => {
            const state = busy[file.id]
            return (
              <ItemContextMenu
                key={file.id}
                entries={attachmentEntries({
                  onDownload: () => download(file),
                  canDownload: canDownload(file),
                  onRename: onRename ? () => setRenaming(file.id) : undefined,
                  onDelete: onDelete ? () => setConfirming(file) : undefined,
                  disabled: Boolean(state) || renaming === file.id,
                })}
                render={<li />}
                className={cn('flex min-w-0 flex-col gap-1 px-2.5 py-2', state?.kind === 'delete' && 'opacity-60')}
              >
                <div className='flex min-w-0 items-center gap-2.5'>
                  <FileTypeIcon attachment={file} />
                  <div className='flex min-w-0 flex-1 flex-col'>
                    {renaming === file.id ? (
                      <RenameField name={file.name} onCommit={(next) => void rename(file.id, next)} onCancel={() => setRenaming(null)} />
                    ) : (
                      <span className='truncate text-sm' title={file.name}>
                        {file.name}
                      </span>
                    )}
                    <span className='flex min-w-0 items-center gap-1 text-xs text-muted-foreground'>
                      <span className='shrink-0 tabular-nums'>{formatFileSize(file.size)}</span>
                      <span aria-hidden='true'>·</span>
                      <Uploader uploader={file.uploader} />
                      <span aria-hidden='true'>·</span>
                      <span className='shrink-0 whitespace-nowrap'>{when(file.createdAt)}</span>
                    </span>
                  </div>
                  {state ? <Loader2 aria-label={state.kind === 'delete' ? 'Deleting' : 'Renaming'} className='size-4 shrink-0 animate-spin text-muted-foreground' /> : null}
                  <Button variant='ghost' size='icon-sm' aria-label={`Download ${file.name}`} title='Download' disabled={Boolean(state)} {...attachmentDownloadProps(file, onDownload)}>
                    <Download aria-hidden='true' />
                  </Button>
                  <ActionsMenu
                    attachment={file}
                    onDownload={() => download(file)}
                    canDownload={canDownload(file)}
                    onRename={onRename ? () => setRenaming(file.id) : undefined}
                    onDelete={onDelete ? () => setConfirming(file) : undefined}
                    disabled={Boolean(state)}
                  />
                </div>
                {failures[file.id] ? (
                  <Problem onDismiss={() => setFailureFor(file.id, null)} dismissLabel='Dismiss'>
                    {failures[file.id]}
                  </Problem>
                ) : null}
              </ItemContextMenu>
            )
          })}
          {uploads.map((upload) => (
            <li key={upload.id} className='flex min-w-0 flex-col gap-1.5 px-2.5 py-2'>
              <div className='flex min-w-0 items-center gap-2.5'>
                {upload.error ? <CircleAlert aria-hidden='true' className='size-4 shrink-0 text-destructive' /> : <Loader2 aria-hidden='true' className='size-4 shrink-0 animate-spin text-muted-foreground' />}
                <span className='min-w-0 flex-1 truncate text-sm' title={upload.name}>
                  {upload.name}
                </span>
                <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>
                  {upload.error ? formatFileSize(upload.size) : upload.progress === null ? `Uploading · ${formatFileSize(upload.size)}` : `${Math.round(upload.progress * 100)}% of ${formatFileSize(upload.size)}`}
                </span>
                {!upload.error && onDismissUpload ? (
                  <Button variant='ghost' size='icon-sm' aria-label={`Cancel uploading ${upload.name}`} title='Cancel' onClick={() => onDismissUpload(upload.id)}>
                    <X aria-hidden='true' />
                  </Button>
                ) : null}
              </div>
              {upload.error ? (
                <Problem onRetry={onRetryUpload ? () => onRetryUpload(upload.id) : undefined} onDismiss={onDismissUpload ? () => onDismissUpload(upload.id) : undefined} dismissLabel={`Dismiss ${upload.name}`}>
                  {upload.error}
                </Problem>
              ) : (
                <ProgressBar progress={upload.progress} label={`Uploading ${upload.name}`} />
              )}
            </li>
          ))}
          {refused.map((refusal) => (
            <li key={refusal.key} className='flex min-w-0 flex-col gap-1.5 px-2.5 py-2'>
              <div className='flex min-w-0 items-center gap-2.5'>
                <CircleAlert aria-hidden='true' className='size-4 shrink-0 text-destructive' />
                <span className='min-w-0 flex-1 truncate text-sm' title={refusal.name}>
                  {refusal.name}
                </span>
                <span className='shrink-0 text-xs text-muted-foreground tabular-nums'>{formatRefusedSize(refusal.size)}</span>
              </div>
              <Problem onDismiss={() => setRefused((current) => current.filter((item) => item.key !== refusal.key))} dismissLabel={`Dismiss ${refusal.name}`}>
                Not attached: it is {formatRefusedSize(refusal.size)}, and the limit is {limit} per file.
              </Problem>
            </li>
          ))}
        </ul>
      ) : null}

      {!empty && onUpload ? (
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
          {pickButton}
          <span className='text-xs text-muted-foreground'>Or drop files, or paste an image. Up to {limit} each.</span>
        </div>
      ) : null}

      {over ? <DropOverlay /> : null}

      <TaskAttachmentViewer items={attachments} openId={viewing} onOpenChange={setViewing} onDownload={onDownload} />

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(null)
          }
        }}
      >
        <DialogContent role='alertdialog' showCloseButton={false} className='sm:max-w-sm'>
          <DialogHeader>
            <DialogTitle className='break-all'>Delete {confirming?.name}?</DialogTitle>
            <DialogDescription>It is removed from the task for everyone, and it cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant='outline' />}>Cancel</DialogClose>
            <Button
              variant='destructive'
              onClick={() => {
                if (confirming) {
                  void remove(confirming)
                }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Thumbnail({ image }: { image: TaskAttachment }) {
  const source = image.previewUrl ?? null
  const [failed, setFailed] = useState<string | null>(null)
  if (source === null) {
    // The box holds its place while the host fetches the image.
    return (
      <span className='flex size-full animate-pulse items-center justify-center'>
        <FileImage aria-hidden='true' className='size-5 text-muted-foreground' />
      </span>
    )
  }
  if (failed === source) {
    return (
      <span className='flex size-full items-center justify-center'>
        <ImageOff aria-hidden='true' className='size-5 text-muted-foreground' />
      </span>
    )
  }
  return <img src={source} alt='' loading='lazy' decoding='async' draggable={false} onError={() => setFailed(source)} className='size-full object-cover' />
}
