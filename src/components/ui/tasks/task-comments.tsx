import { Loader2 } from 'lucide-react'
import { type ClipboardEvent, type ReactNode, type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'

import { MessageActionsProvider, MessageContextMenu } from '@/components/message-context-menu'
import { appendQuotedReply } from '@/components/message-quote'
import { Button } from '../button'
import { Textarea } from '../textarea'
import { cn } from 'cn'

import { ItemActionsMenu, ItemContextMenu, type ItemMenuEntries } from './item-menu'
import { TaskAssignee } from './task-assignee'

export interface TaskCommentItem {
  id: number | string
  author: { kind: 'agent' | 'person'; name: string }
  body: string
  createdAt: string
  /** Later than `createdAt` once the comment was edited, which it then says. */
  updatedAt?: string
}

export interface TaskCommentsProps {
  comments: TaskCommentItem[]
  /** Posts a comment; the composer clears when it resolves and keeps the text when it rejects. */
  onPost?: (body: string) => Promise<unknown> | unknown
  /** Renders a comment body (markdown). Plain text when not given. */
  renderBody?: (body: string) => ReactNode
  /**
   * Uploads an image pasted into the composer and resolves to the markdown that
   * shows it. A placeholder holds its place meanwhile, and posting waits until
   * every upload has settled; a rejection removes the placeholder and shows its
   * message. Without it, a paste is left to the textarea. Editing a comment
   * takes pastes the same way.
   */
  onPasteImage?: (file: File) => Promise<string>
  /**
   * A comment's menu, on right-click, long press, the Menu key or Shift+F10,
   * and behind its … button: e.g. Copy link, and Edit and Delete… on your own.
   */
  commentMenu?: (comment: TaskCommentItem) => ItemMenuEntries
  /** The comment being edited: it shows as a composer holding its text. */
  editingId?: TaskCommentItem['id'] | null
  /** Saves the edited text; the editor closes when it resolves and keeps the text when it rejects. */
  onEditSave?: (comment: TaskCommentItem, body: string) => Promise<unknown> | unknown
  /** Esc or Cancel in the editor. */
  onEditCancel?: () => void
  /** A comment to show as the one a link pointed at. */
  highlightId?: TaskCommentItem['id'] | null
  className?: string
}

function when(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** A refusal's own words, without the transport's error-class prefix. */
function messageOf(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught)
  return raw.replace(/^[A-Za-z]*Error:\s*/, '') || 'Could not post the comment'
}

/** Writes a reply into a composer: the text quoted below what is already there, the caret after it. */
interface ComposerReply {
  reply: (text: string) => void
}

interface ComposerProps {
  initial?: string
  /** Resolving clears a new comment's composer; rejecting keeps the text and shows why. */
  onSubmit: (body: string) => Promise<unknown> | unknown
  submitLabel: string
  onCancel?: () => void
  onPasteImage?: (file: File) => Promise<string>
  clearOnSubmit?: boolean
  autoFocus?: boolean
  label: string
  placeholder?: string
  replyRef?: Ref<ComposerReply>
}

/** The text box with pasted-image uploads, Ctrl/⌘+Enter to submit and Esc to cancel. */
function Composer({ initial = '', onSubmit, submitLabel, onCancel, onPasteImage, clearOnSubmit, autoFocus, label, placeholder, replyRef }: ComposerProps) {
  const [draft, setDraft] = useState(initial)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const [pending, setPending] = useState(false)
  // Why the last post or upload was refused, shown by the button until the draft changes.
  const [error, setError] = useState<string | null>(null)
  // Pasted images still uploading, and whether a post is waiting for them.
  const [uploads, setUploads] = useState(0)
  const [postWhenReady, setPostWhenReady] = useState(false)
  // Numbers each placeholder, so two pastes of the same name are swapped apart.
  const nextUpload = useRef(0)

  useImperativeHandle(replyRef, () => ({
    reply: (text) => {
      setDraft((current) => appendQuotedReply(current, text))
      setError(null)
      // After the quote has rendered, so the caret lands past it.
      requestAnimationFrame(() => {
        const field = fieldRef.current
        if (field) {
          field.focus()
          field.setSelectionRange(field.value.length, field.value.length)
        }
      })
    },
  }))

  const post = async () => {
    const body = draft.trim()
    if (uploads > 0) {
      setPostWhenReady(true)
      return
    }
    if (!body || pending) {
      return
    }
    setPending(true)
    setError(null)
    try {
      await onSubmit(body)
      if (clearOnSubmit) {
        setDraft('')
      }
    } catch (caught) {
      // The draft stays for a retry.
      setError(messageOf(caught))
    } finally {
      setPending(false)
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the last upload settles; post reads the draft that settled
  useEffect(() => {
    if (postWhenReady && uploads === 0) {
      setPostWhenReady(false)
      void post()
    }
  }, [postWhenReady, uploads])

  const pasteImages = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'))
    // Copied text wins: a clipboard carrying both is a copy from a page, not a screenshot.
    if (!onPasteImage || images.length === 0 || event.clipboardData.getData('text/plain')) {
      return
    }
    event.preventDefault()
    const field = event.currentTarget
    const placeholders = images.map((file) => `[Uploading ${file.name}… #${++nextUpload.current}]`)
    const inserted = placeholders.join('\n')
    setDraft((current) => current.slice(0, field.selectionStart) + inserted + current.slice(field.selectionEnd))
    setError(null)
    setUploads((count) => count + images.length)
    images.forEach((file, i) => {
      const placeholder = placeholders[i] as string
      onPasteImage(file)
        .then((markdown) => setDraft((current) => current.replace(placeholder, markdown)))
        .catch((caught) => {
          setDraft((current) => current.replace(placeholder, ''))
          setError(messageOf(caught))
          setPostWhenReady(false)
        })
        .finally(() => setUploads((count) => count - 1))
    })
  }

  return (
    <div className='flex flex-col gap-2'>
      <Textarea
        ref={fieldRef}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          setError(null)
        }}
        aria-invalid={error ? true : undefined}
        onPaste={pasteImages}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void post()
          } else if (event.key === 'Escape' && onCancel) {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          }
        }}
        // biome-ignore lint/a11y/noAutofocus: the editor opens because the person asked to edit
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={label}
        className='min-h-20'
      />
      <div className='flex items-center justify-end gap-2'>
        {error ? (
          <p role='alert' className='mr-auto min-w-0 text-xs text-destructive'>
            {error}
          </p>
        ) : null}
        <span className='hidden text-xs text-muted-foreground sm:inline'>Ctrl + Enter to {submitLabel.toLowerCase()}</span>
        {onCancel ? (
          <Button size='sm' variant='ghost' onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
        <Button size='sm' onClick={() => void post()} disabled={!draft.trim() || pending || uploads > 0}>
          {pending || uploads > 0 ? <Loader2 className='animate-spin' /> : null}
          {uploads > 0 ? 'Uploading…' : submitLabel}
        </Button>
      </div>
    </div>
  )
}

/**
 * A task's conversation: comments oldest first, each with its author — person
 * or agent — and time, and a composer at the end. Ctrl/⌘+Enter posts. Each
 * comment can carry a menu (copy its link; edit or delete your own), and one
 * at a time can be edited in place. A comment's text carries the chat's
 * message menu: Copy, and Reply into the composer, on what is selected in it
 * or else on the whole comment.
 */
export function TaskComments({
  comments,
  onPost,
  renderBody,
  onPasteImage,
  commentMenu,
  editingId = null,
  onEditSave,
  onEditCancel,
  highlightId = null,
  className,
}: TaskCommentsProps) {
  const replyRef = useRef<ComposerReply>(null)
  // Reply needs a composer to quote into; without one the menu offers Copy alone.
  const messageActions = useMemo(() => (onPost ? { onReply: (text: string) => replyRef.current?.reply(text) } : {}), [onPost])
  const list = (
    <div data-slot='task-comments' className={cn('flex flex-col gap-4', className)}>
      {comments.length === 0 ? <p className='text-sm text-muted-foreground'>No comments yet.</p> : null}
      {comments.map((comment) => {
        const editing = editingId !== null && comment.id === editingId && onEditSave
        const entries = editing ? [] : (commentMenu?.(comment) ?? [])
        const edited = comment.updatedAt && comment.updatedAt !== comment.createdAt
        return (
          <ItemContextMenu
            key={comment.id}
            entries={entries}
            // Focusable when it has a menu, so the Menu key and Shift+F10 reach it.
            render={<div data-comment-id={comment.id} tabIndex={entries.length > 0 ? 0 : undefined} />}
            className={cn(
              // A comment's text stays selectable for copying.
              'group/comment -mx-2 flex gap-3 rounded-md px-2 py-1 outline-none select-text focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
              comment.id === highlightId && 'bg-primary/5 ring-1 ring-primary/30',
            )}
          >
            <TaskAssignee assignee={comment.author} className='mt-0.5 self-start' />
            <div className='flex min-w-0 flex-1 flex-col gap-1'>
              <div className='flex items-baseline gap-2 text-sm'>
                <span className='font-medium'>{comment.author.name}</span>
                {comment.author.kind === 'agent' ? <span className='inline-flex h-5 items-center rounded-md bg-primary/10 px-1.5 text-[11px] font-medium text-primary'>Agent</span> : null}
                <span className='text-xs text-muted-foreground'>{when(comment.createdAt)}</span>
                {edited ? (
                  <span className='text-xs text-muted-foreground' title={`Edited ${when(comment.updatedAt as string)}`}>
                    (edited)
                  </span>
                ) : null}
                {entries.length > 0 ? (
                  <ItemActionsMenu
                    entries={entries}
                    label={`Comment by ${comment.author.name} actions`}
                    size='icon-xs'
                    className='ml-auto self-center opacity-0 group-hover/comment:opacity-100 group-focus-within/comment:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100'
                  />
                ) : null}
              </div>
              {editing ? (
                <Composer
                  initial={comment.body}
                  onSubmit={(body) => onEditSave(comment, body)}
                  submitLabel='Save'
                  onCancel={onEditCancel}
                  onPasteImage={onPasteImage}
                  autoFocus
                  label='Edit the comment'
                />
              ) : (
                <MessageContextMenu text={comment.body} className='text-sm break-words'>
                  {renderBody ? renderBody(comment.body) : <p className='whitespace-pre-wrap'>{comment.body}</p>}
                </MessageContextMenu>
              )}
            </div>
          </ItemContextMenu>
        )
      })}
      {onPost ? (
        <Composer
          onSubmit={onPost}
          submitLabel='Comment'
          onPasteImage={onPasteImage}
          clearOnSubmit
          label='Add a comment'
          placeholder='Add a comment… (markdown)'
          replyRef={replyRef}
        />
      ) : null}
    </div>
  )
  return <MessageActionsProvider value={messageActions}>{list}</MessageActionsProvider>
}
