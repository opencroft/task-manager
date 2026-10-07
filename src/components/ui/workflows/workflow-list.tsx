import { Copy, MoreHorizontal, Plus, Star, Trash2 } from "lucide-react"

import { Button } from "../button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../context-menu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../dropdown-menu"
import { ScrollArea } from "@/components/ui/layout/scroll-area"
import { MENU_SCROLL_POPUP, MenuScrollArea } from "@/components/ui/tasks/item-menu"
import { cn } from "@/lib/utils"

/** The fields the list reads, named as a workflow definition carries them, so a definition passes in as it is. */
export interface WorkflowListItem {
  id: string
  name: string
  isDefault: boolean
  steps: readonly unknown[]
}

export interface WorkflowListProps<T extends WorkflowListItem> {
  workflows: T[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** Starts a new workflow. The New button is disabled while one is being created. */
  onCreate: () => void
  /** The name of the workflow being created, shown as the selected row; null when none is. */
  creatingName?: string | null
  onMakeDefault: (workflow: T) => void
  onDuplicate: (workflow: T) => void
  onDelete: (workflow: T) => void
  /**
   * `panel` (the default): a column beside the editor on the page.
   * `sidebar`: the App sidebar's section under the pages (TasksSidebar's
   * children), in the sidebar's colours; it fills the height left and its
   * rows scroll while the heading and New stay put.
   */
  variant?: "panel" | "sidebar"
  className?: string
}

const EMPTY = "None yet. A workflow takes a task through steps — say, development then review — and opens a chat session for the agent working each one."

/**
 * The project's workflows, for the side of the Workflows page or the App
 * sidebar. A row selects its workflow; its menu (the "…" button, or a
 * right-click / long press on the row) makes it the default, duplicates or
 * deletes it.
 */
export function WorkflowList<T extends WorkflowListItem>({
  workflows,
  selectedId,
  onSelect,
  onCreate,
  creatingName = null,
  onMakeDefault,
  onDuplicate,
  onDelete,
  variant = "panel",
  className,
}: WorkflowListProps<T>) {
  const creating = creatingName !== null
  const sidebar = variant === "sidebar"

  const menu = (
    wf: T,
    Item: typeof ContextMenuItem | typeof DropdownMenuItem,
    Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator,
  ) => (
    <>
      <Item disabled={wf.isDefault} onClick={() => onMakeDefault(wf)}>
        <Star />
        Make default
      </Item>
      <Item onClick={() => onDuplicate(wf)}>
        <Copy />
        Duplicate
      </Item>
      <Separator />
      <Item variant="destructive" onClick={() => onDelete(wf)}>
        <Trash2 />
        Delete
      </Item>
    </>
  )

  const list =
    workflows.length === 0 && !creating ? (
      <p className={cn("text-muted-foreground", sidebar ? "px-2 text-xs" : "text-sm")}>{EMPTY}</p>
    ) : (
      <ul className="flex flex-col gap-0.5">
        {workflows.map((wf) => {
          const active = !creating && wf.id === selectedId
          return (
            <ContextMenu key={wf.id}>
              <ContextMenuTrigger render={<li className="relative" />}>
                <button
                  type="button"
                  onClick={() => onSelect(wf.id)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex w-full flex-col items-start gap-0.5 rounded-md text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset",
                    sidebar
                      ? cn(
                          "px-2 py-1.5 pr-9 ring-sidebar-ring",
                          active ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                        )
                      : cn("px-3 py-2 pr-10 focus-visible:ring-ring/50", active ? "bg-muted font-medium" : "hover:bg-muted/60"),
                  )}
                >
                  <span className="flex w-full min-w-0 items-center gap-1.5">
                    <span className="truncate">{wf.name}</span>
                    {wf.isDefault ? <span className="inline-flex h-5 shrink-0 items-center rounded-md bg-primary/10 px-1.5 text-[11px] font-medium text-primary">default</span> : null}
                  </span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {wf.steps.length} step{wf.steps.length === 1 ? "" : "s"}
                  </span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${wf.name} actions`}
                        className={cn("absolute text-muted-foreground", sidebar ? "top-1 right-1" : "top-1.5 right-1.5")}
                      />
                    }
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className={MENU_SCROLL_POPUP}>
                    <MenuScrollArea>{menu(wf, DropdownMenuItem, DropdownMenuSeparator)}</MenuScrollArea>
                  </DropdownMenuContent>
                </DropdownMenu>
              </ContextMenuTrigger>
              <ContextMenuContent className={MENU_SCROLL_POPUP}>
                <MenuScrollArea>{menu(wf, ContextMenuItem, ContextMenuSeparator)}</MenuScrollArea>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
        {creating ? (
          <li
            className={cn("truncate rounded-md text-sm font-medium", sidebar ? "bg-sidebar-accent px-2 py-1.5 text-sidebar-accent-foreground" : "bg-muted px-3 py-2")}
            aria-current="page"
          >
            {creatingName || "New workflow"}
          </li>
        ) : null}
      </ul>
    )

  if (sidebar) {
    return (
      <section data-slot="workflow-list" data-variant="sidebar" aria-label="Workflows" className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 pr-2 pl-4">
          <h2 className="truncate text-xs font-medium text-sidebar-foreground/70">Workflows</h2>
          <Button variant="ghost" size="icon-sm" aria-label="New workflow" onClick={onCreate} disabled={creating}>
            <Plus />
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1" innerClassName="px-2 pb-2">
          {list}
        </ScrollArea>
      </section>
    )
  }

  return (
    <div data-slot="workflow-list" className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Workflows</h2>
        <Button size="sm" variant="outline" onClick={onCreate} disabled={creating}>
          <Plus />
          New
        </Button>
      </div>
      {list}
    </div>
  )
}
