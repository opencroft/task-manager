import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

export type BoardDropIndicatorVariant = 'line' | 'slot'

export interface BoardDropIndicatorProps extends ComponentProps<'div'> {
  /**
   * `line`: a thin bar between two cards, drawn in the column's gap so the
   * cards around it do not move. `slot`: a dashed, card-sized gap, for the
   * end of a column or a column with nothing in it yet.
   */
  variant?: BoardDropIndicatorVariant
}

/**
 * Where a dragged card will land. Render it in the column's card list at the
 * position the drop would take; it carries no behaviour of its own.
 */
export function BoardDropIndicator({ variant = 'line', className, ...props }: BoardDropIndicatorProps) {
  if (variant === 'slot') {
    return (
      <div
        aria-hidden='true'
        data-slot='board-drop-indicator'
        data-variant='slot'
        className={cn('h-16 w-full shrink-0 rounded-lg border-2 border-dashed border-primary/40 bg-primary/5', className)}
        {...props}
      />
    )
  }
  // The column spaces cards 8px apart; the negative margin folds this bar
  // into that gap, so showing it never shifts a card.
  return (
    <div
      aria-hidden='true'
      data-slot='board-drop-indicator'
      data-variant='line'
      className={cn('relative -my-[5px] h-0.5 w-full shrink-0 rounded-full bg-primary', className)}
      {...props}
    >
      <span className='absolute top-1/2 -left-1 size-2 -translate-y-1/2 rounded-full border-2 border-primary bg-background' />
    </div>
  )
}
