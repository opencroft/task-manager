import { Check, MoreHorizontal } from 'lucide-react'
import { cloneElement, type ComponentType, type MouseEvent, type ReactElement, type ReactNode } from 'react'

import { Button } from '../button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../dropdown-menu'
import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { cn } from 'cn'

/**
 * Where an entry sits. The groups run in task-menu's order, a separator
 * between each: `open` (Open, Copy …), `change` (a field ▸ its values),
 * `act` (everything else), and destructive entries last whatever their group.
 */
export type ItemMenuGroup = 'open' | 'change' | 'act'

type Icon = ComponentType<{ className?: string }>

export interface ItemMenuAction {
  id: string
  label: ReactNode
  icon?: Icon
  onSelect: () => void
  group?: ItemMenuGroup
  disabled?: boolean
  /** Shown with a check: the current value among its siblings. */
  checked?: boolean
  /** Drawn last, in red. Its handler asks for confirmation first; end the label with “…”. */
  destructive?: boolean
}

export interface ItemMenuSubmenu {
  id: string
  label: ReactNode
  icon?: Icon
  group?: ItemMenuGroup
  entries: ItemMenuAction[]
}

export type ItemMenuEntry = ItemMenuAction | ItemMenuSubmenu

/** Leave an entry out with any falsy value, so a list can be written as `condition && entry`. */
export type ItemMenuEntries = (ItemMenuEntry | false | null | undefined | '' | 0)[]

interface Parts {
  Item: ComponentType<{ onClick?: () => void; variant?: 'default' | 'destructive'; disabled?: boolean; children: ReactNode }>
  Separator: ComponentType
  Sub: ComponentType<{ children: ReactNode }>
  SubTrigger: ComponentType<{ children: ReactNode }>
  SubContent: ComponentType<{ children: ReactNode; className?: string }>
}

const CONTEXT: Parts = {
  Item: ContextMenuItem as Parts['Item'],
  Separator: ContextMenuSeparator as Parts['Separator'],
  Sub: ContextMenuSub as Parts['Sub'],
  SubTrigger: ContextMenuSubTrigger as Parts['SubTrigger'],
  SubContent: ContextMenuSubContent as Parts['SubContent'],
}

const DROPDOWN: Parts = {
  Item: DropdownMenuItem as Parts['Item'],
  Separator: DropdownMenuSeparator as Parts['Separator'],
  Sub: DropdownMenuSub as Parts['Sub'],
  SubTrigger: DropdownMenuSubTrigger as Parts['SubTrigger'],
  SubContent: DropdownMenuSubContent as Parts['SubContent'],
}

const ORDER: ItemMenuGroup[] = ['open', 'change', 'act']

/** Add to a menu or popover popup's classes when its items go in a MenuScrollArea: the area pads and scrolls them. */
export const MENU_SCROLL_POPUP = 'overflow-hidden p-0'

/**
 * A menu popup's items in the kit's ScrollArea. It takes the popup's height
 * limit (the room on screen, or the popup's own `max-h-*`), so give the popup
 * MENU_SCROLL_POPUP and let the area pad and scroll the items.
 */
export function MenuScrollArea({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ScrollArea className='max-h-[inherit]' innerClassName={cn('p-1', className)}>
      {children}
    </ScrollArea>
  )
}

function isSubmenu(entry: ItemMenuEntry): entry is ItemMenuSubmenu {
  return 'entries' in entry
}

/** The entries that will be drawn, in their groups; empty when there is nothing to offer. */
export function itemMenuGroups(entries: ItemMenuEntries): ItemMenuEntry[][] {
  const present = entries.filter((entry): entry is ItemMenuEntry => Boolean(entry) && (!isSubmenu(entry as ItemMenuEntry) || (entry as ItemMenuSubmenu).entries.length > 0))
  const destructive = present.filter((entry) => !isSubmenu(entry) && entry.destructive)
  const groups = ORDER.map((group) => present.filter((entry) => (entry.group ?? 'act') === group && !destructive.includes(entry)))
  return [...groups, destructive].filter((group) => group.length > 0)
}

function Choice({ P, entry }: { P: Parts; entry: ItemMenuAction }) {
  const Icon = entry.icon
  return (
    <P.Item onClick={entry.onSelect} disabled={entry.disabled} variant={entry.destructive ? 'destructive' : 'default'}>
      {Icon ? <Icon /> : null}
      {entry.label}
      {entry.checked !== undefined ? <Check className={cn('ml-auto size-4', entry.checked ? 'opacity-100' : 'opacity-0')} /> : null}
    </P.Item>
  )
}

function ItemMenuItems({ P, entries }: { P: Parts; entries: ItemMenuEntries }) {
  return (
    <>
      {itemMenuGroups(entries).map((group, index) => (
        <span key={group[0].id} className='contents'>
          {index > 0 ? <P.Separator /> : null}
          {group.map((entry) => {
            if (!isSubmenu(entry)) {
              return <Choice key={entry.id} P={P} entry={entry} />
            }
            const Icon = entry.icon
            return (
              <P.Sub key={entry.id}>
                <P.SubTrigger>
                  {Icon ? <Icon /> : null}
                  {entry.label}
                </P.SubTrigger>
                <P.SubContent className={cn('max-h-72 min-w-44', MENU_SCROLL_POPUP)}>
                  <MenuScrollArea>
                    {entry.entries.map((choice) => (
                      <Choice key={choice.id} P={P} entry={choice} />
                    ))}
                  </MenuScrollArea>
                </P.SubContent>
              </P.Sub>
            )
          })}
        </span>
      ))}
    </>
  )
}

export interface ItemContextMenuProps {
  entries: ItemMenuEntries
  /** The element the menu opens on (a header cell, a row); defaults to a div. */
  render?: ReactElement
  /**
   * Whether the default div takes focus, so the Menu key and Shift+F10 reach
   * it. Leave it on unless the element inside is already focusable.
   */
  focusable?: boolean
  children: ReactNode
  className?: string
}

/**
 * The menu of one thing on the page, on right-click, a long press, the Menu
 * key or Shift+F10. Inside another item's menu area it opens its own menu, not
 * the outer one. With nothing to offer it renders its children as they are.
 */
export function ItemContextMenu({ entries, render, focusable = true, children, className }: ItemContextMenuProps) {
  if (itemMenuGroups(entries).length === 0) {
    if (render) {
      const element = render as ReactElement<{ className?: string; children?: ReactNode }>
      return cloneElement(element, { className: cn(element.props.className, className) }, children)
    }
    return <div className={className}>{children}</div>
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={render}
        tabIndex={render || !focusable ? undefined : 0}
        // Inset, so a full-width row inside a rounded, clipped list keeps its whole ring.
        className={cn(!render && focusable && 'outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset', className)}
        onContextMenu={(event: MouseEvent) => event.stopPropagation()}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className={cn('min-w-48', MENU_SCROLL_POPUP)}>
        <MenuScrollArea>
          <ItemMenuItems P={CONTEXT} entries={entries} />
        </MenuScrollArea>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export interface ItemActionsMenuProps {
  entries: ItemMenuEntries
  /** Accessible name of the … button. */
  label: string
  /** The button's size; `icon-sm` like every other … in the kit. */
  size?: 'icon-sm' | 'icon-xs'
  className?: string
}

/** The same entries behind a … button, so nothing needs a right-click. */
export function ItemActionsMenu({ entries, label, size = 'icon-sm', className }: ItemActionsMenuProps) {
  if (itemMenuGroups(entries).length === 0) {
    return null
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant='ghost' size={size} aria-label={label} title={label} className={className} />}
        onClick={(event: MouseEvent) => event.stopPropagation()}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className={cn('w-auto min-w-48', MENU_SCROLL_POPUP)}>
        <MenuScrollArea>
          <ItemMenuItems P={DROPDOWN} entries={entries} />
        </MenuScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
