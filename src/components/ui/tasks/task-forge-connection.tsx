import { CircleAlert, GitPullRequest, KeyRound, Loader2, X } from 'lucide-react'
import { type FormEvent, type ReactNode, useId, useState } from 'react'

import { Button } from '../button'
import { Input } from '../input'
import { Skeleton } from '../skeleton'
import { TaskManagerError } from '../states/task-manager-error'
import { cn } from '@/lib/utils'

/** Where pull requests are read from. `secretKey` names a Secrets Store key; the token itself never reaches the page. */
export interface TaskForgeConnectionValue {
  url: string
  /** The organisation or user whose repositories are read. */
  owner: string
  secretKey: string
}

export interface TaskForgeStatus {
  connection: TaskForgeConnectionValue | null
  /** When the forge was last read (ISO 8601); null before the first read. */
  lastSyncAt: string | null
  /** Why the last read failed; null when it did not. */
  lastError: string | null
  /** Pull requests read, and how many of them mention a task. */
  pullRequests: number
  linked: number
}

export interface TaskForgeConnectionProps {
  /** Null while loading. */
  status: TaskForgeStatus | null
  /** Why the status could not load. */
  error?: string | null
  onRetry?: () => void
  /** Saves the connection; a rejection's message shows in place. */
  onConnect: (value: TaskForgeConnectionValue) => Promise<unknown>
  onDisconnect: () => Promise<unknown>
  /** What a new connection's fields start with. */
  defaults?: Partial<TaskForgeConnectionValue>
  /** The prefix every key name must have, checked as it is typed. */
  secretKeyPrefix?: string
  /** How often the forge is read, for the wording. */
  pollSeconds?: number
  className?: string
}

function messageOf(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return raw.replace(/^[A-Za-z]*Error:\s*/, '') || fallback
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

function ago(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (Number.isNaN(seconds)) {
    return iso
  }
  if (seconds < 60) {
    return 'less than a minute ago'
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)} min ago`
  }
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function Problem({ children, onDismiss }: { children: ReactNode; onDismiss?: () => void }) {
  return (
    <div role='alert' className='flex min-w-0 items-start gap-1.5 text-xs text-destructive'>
      <CircleAlert aria-hidden='true' className='mt-0.5 size-3.5 shrink-0' />
      <p className='min-w-0 flex-1 break-words'>{children}</p>
      {onDismiss ? (
        <Button variant='ghost' size='icon-xs' className='-my-0.5 size-5' aria-label='Dismiss' onClick={onDismiss}>
          <X aria-hidden='true' />
        </Button>
      ) : null}
    </div>
  )
}

function ConnectForm({
  initial,
  secretKeyPrefix,
  onConnect,
  onCancel,
}: {
  initial: TaskForgeConnectionValue
  secretKeyPrefix?: string
  onConnect: TaskForgeConnectionProps['onConnect']
  onCancel?: () => void
}) {
  const [url, setUrl] = useState(initial.url)
  const [owner, setOwner] = useState(initial.owner)
  const [secretKey, setSecretKey] = useState(initial.secretKey)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const id = useId()
  const keyProblem = secretKeyPrefix && secretKey.trim() && !secretKey.trim().startsWith(secretKeyPrefix) ? `The key name starts with ${secretKeyPrefix}.` : null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || keyProblem) {
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      await onConnect({ url: url.trim(), owner: owner.trim(), secretKey: secretKey.trim() })
    } catch (caught) {
      setFailure(messageOf(caught, 'Could not connect the forge'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className='flex min-w-0 max-w-xl flex-col gap-4'>
      <label className='flex flex-col gap-1.5 text-sm'>
        <span className='font-medium'>Forge address</span>
        <Input type='url' inputMode='url' required value={url} onChange={(event) => setUrl(event.target.value)} placeholder='https://git.example.com' />
      </label>
      <div className='flex flex-col gap-1.5 text-sm'>
        <label htmlFor={`${id}-owner`} className='font-medium'>
          Owner
        </label>
        <Input
          id={`${id}-owner`}
          aria-describedby={`${id}-owner-help`}
          required
          value={owner}
          onChange={(event) => setOwner(event.target.value)}
          placeholder='acme'
          autoComplete='off'
          spellCheck={false}
          className='font-mono'
        />
        <p id={`${id}-owner-help`} className='text-xs text-muted-foreground'>
          The organisation or user whose repositories are read.
        </p>
      </div>
      <div className='flex flex-col gap-1.5 text-sm'>
        <label htmlFor={`${id}-key`} className='font-medium'>
          Secrets Store key
        </label>
        <Input
          id={`${id}-key`}
          aria-describedby={`${id}-key-help`}
          required
          value={secretKey}
          onChange={(event) => setSecretKey(event.target.value)}
          aria-invalid={keyProblem ? true : undefined}
          placeholder={secretKeyPrefix ? `${secretKeyPrefix}TASKS_TOKEN` : undefined}
          autoComplete='off'
          spellCheck={false}
          className='font-mono'
        />
        {keyProblem ? <Problem>{keyProblem}</Problem> : null}
        <p id={`${id}-key-help`} className='flex items-start gap-1.5 text-xs text-muted-foreground'>
          <KeyRound aria-hidden='true' className='mt-0.5 size-3.5 shrink-0' />
          <span>
            The name of the key that holds a forge access token with read:repository and read:issue. The token is read on the server for each read of the forge and never shown here; nothing is ever written to the forge.
          </span>
        </p>
      </div>
      {failure ? <Problem onDismiss={() => setFailure(null)}>{failure}</Problem> : null}
      <div className='flex items-center gap-2'>
        <Button type='submit' disabled={busy || Boolean(keyProblem)}>
          {busy ? <Loader2 aria-hidden='true' className='animate-spin' /> : null}
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
        {onCancel ? (
          <Button type='button' variant='outline' onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  )
}

/**
 * The forge connection on the settings page. Every change goes through the
 * host's callbacks; the page never sees the token, only the key's name.
 */
export function TaskForgeConnection({
  status,
  error = null,
  onRetry,
  onConnect,
  onDisconnect,
  defaults,
  secretKeyPrefix,
  pollSeconds = 60,
  className,
}: TaskForgeConnectionProps) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  if (!status) {
    return error ? (
      <TaskManagerError title='The forge connection could not load' message={error} onRetry={onRetry} className={className} />
    ) : (
      <div aria-hidden='true' className={cn('flex max-w-xl flex-col gap-3', className)}>
        <Skeleton className='h-4 w-64' />
        <Skeleton className='h-9 w-full' />
        <Skeleton className='h-9 w-full' />
      </div>
    )
  }

  const connection = status.connection
  if (!connection || editing) {
    return (
      <div className={cn('flex min-w-0 flex-col gap-4', className)}>
        {!connection ? (
          <p className='max-w-xl text-sm text-muted-foreground'>
            Connect the forge and every pull request that names a task's key in its title, description or branch shows on that task, with its state, kept current every {pollSeconds} seconds.
          </p>
        ) : null}
        <ConnectForm
          initial={{ url: connection?.url ?? defaults?.url ?? '', owner: connection?.owner ?? defaults?.owner ?? '', secretKey: connection?.secretKey ?? defaults?.secretKey ?? '' }}
          secretKeyPrefix={secretKeyPrefix}
          onConnect={async (value) => {
            await onConnect(value)
            setEditing(false)
          }}
          onCancel={connection ? () => setEditing(false) : undefined}
        />
      </div>
    )
  }

  const disconnect = async () => {
    setBusy(true)
    setFailure(null)
    try {
      await onDisconnect()
      setConfirming(false)
    } catch (caught) {
      setFailure(messageOf(caught, 'Could not disconnect the forge'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-slot='task-forge-connection' className={cn('flex min-w-0 max-w-xl flex-col gap-3', className)}>
      <div className='flex min-w-0 items-start gap-3 rounded-lg border px-3 py-3'>
        <GitPullRequest aria-hidden='true' className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
        <dl className='grid min-w-0 flex-1 grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 text-sm'>
          <dt className='text-muted-foreground'>Forge</dt>
          <dd className='min-w-0 truncate'>{connection.url}</dd>
          <dt className='text-muted-foreground'>Owner</dt>
          <dd className='min-w-0 truncate font-mono'>{connection.owner}</dd>
          <dt className='text-muted-foreground'>Key</dt>
          <dd className='min-w-0 truncate font-mono'>{connection.secretKey}</dd>
          <dt className='text-muted-foreground'>Last read</dt>
          <dd className='min-w-0'>
            {status.lastSyncAt ? ago(status.lastSyncAt) : 'Reading for the first time…'}
            {status.lastSyncAt && !status.lastError ? (
              <span className='text-muted-foreground'>
                {' '}
                · {plural(status.pullRequests, 'pull request')}, {status.linked.toLocaleString()} linked to tasks
              </span>
            ) : null}
          </dd>
        </dl>
      </div>
      {status.lastError ? <Problem>The last read failed: {status.lastError}</Problem> : null}
      {failure ? <Problem onDismiss={() => setFailure(null)}>{failure}</Problem> : null}
      {confirming ? (
        <div role='group' aria-label='Disconnect the forge' className='flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 px-3 py-2 text-sm'>
          <span className='min-w-0 flex-1'>Disconnect? Pull requests stop showing on tasks until a forge is connected again.</span>
          <Button variant='destructive' size='sm' onClick={disconnect} disabled={busy}>
            {busy ? <Loader2 aria-hidden='true' className='animate-spin' /> : null}
            Disconnect
          </Button>
          <Button variant='outline' size='sm' onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className='flex items-center gap-2'>
          <Button variant='outline' size='sm' onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button variant='ghost' size='sm' className='text-destructive hover:text-destructive' onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        </div>
      )}
    </div>
  )
}
