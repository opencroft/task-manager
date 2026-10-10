import { Hammer } from 'lucide-react'

import { hrefFor } from '../lib/router'

/** A page that is being built: says what it will do, and points at the list meanwhile. */
export function comingSoon(title: string, purpose: string) {
  function ComingSoon() {
    return (
      <div className='flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center'>
        <span className='flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground'>
          <Hammer className='size-5' />
        </span>
        <div className='flex flex-col gap-1'>
          <h2 className='font-semibold'>{title} is on its way</h2>
          <p className='max-w-sm text-sm text-muted-foreground'>{purpose}</p>
        </div>
        <a href={hrefFor(['tasks'])} className='text-sm text-primary hover:underline'>
          Open the task list
        </a>
      </div>
    )
  }
  ComingSoon.displayName = `ComingSoon(${title})`
  return ComingSoon
}
