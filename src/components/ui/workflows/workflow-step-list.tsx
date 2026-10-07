import { GripVertical, Plus } from "lucide-react"
import { type DragEvent, type ReactNode, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface WorkflowStepListProps<T extends { key: string }> {
  /** The steps in order. `key` is a stable React key, not the step's stored id. */
  items: T[]
  /** Draws one step. Put `dragHandle` where the grip belongs (the step card's `dragHandle` prop); it is null on touch screens. */
  renderStep: (item: T, index: number, dragHandle: ReactNode) => ReactNode
  /** Move the step at `from` so it ends up at index `to`. */
  onReorder: (from: number, to: number) => void
  /** Adds a step at the end. Without it there is no Add button. */
  onAdd?: () => void
  addLabel?: string
  className?: string
}

/** Whether the primary pointer is precise (mouse, trackpad). Dragging is offered only then; touch reorders through each step's menu. */
function useFinePointer(): boolean {
  const [fine, setFine] = useState(false)
  useEffect(() => {
    const query = window.matchMedia("(pointer: fine)")
    setFine(query.matches)
    const onChange = (event: MediaQueryListEvent) => setFine(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return fine
}

/**
 * A workflow's steps in order, with an Add step button at the end. On a mouse
 * or trackpad, a step is dragged by its grip, and a line shows where it will
 * land. Only the grip starts a drag, so text in the step's fields can still
 * be selected. On touch there is no grip; each step's menu moves it.
 */
export function WorkflowStepList<T extends { key: string }>({
  items,
  renderStep,
  onReorder,
  onAdd,
  addLabel = "Add step",
  className,
}: WorkflowStepListProps<T>) {
  const fine = useFinePointer()
  const [armed, setArmed] = useState<number | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  // The gap a drop would land in: 0 is before the first step, items.length after the last.
  const [gap, setGap] = useState<number | null>(null)

  useEffect(() => {
    if (armed === null) {
      return
    }
    // A press on the grip that never became a drag.
    const disarm = () => setArmed((current) => (dragging === null ? null : current))
    window.addEventListener("pointerup", disarm)
    return () => window.removeEventListener("pointerup", disarm)
  }, [armed, dragging])

  const reset = () => {
    setArmed(null)
    setDragging(null)
    setGap(null)
  }

  const over = (event: DragEvent<HTMLLIElement>, index: number) => {
    if (dragging === null) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = "move"
    const rect = event.currentTarget.getBoundingClientRect()
    setGap(event.clientY < rect.top + rect.height / 2 ? index : index + 1)
  }

  const drop = (event: DragEvent<HTMLLIElement>) => {
    event.preventDefault()
    if (dragging !== null && gap !== null) {
      const to = gap > dragging ? gap - 1 : gap
      if (to !== dragging) {
        onReorder(dragging, to)
      }
    }
    reset()
  }

  return (
    <div data-slot="workflow-step-list" className={cn("flex flex-col gap-3", className)}>
      <ol className="flex flex-col gap-3">
        {items.map((item, index) => {
          const handle = fine ? (
            <span
              aria-hidden="true"
              onPointerDown={() => setArmed(index)}
              className="mt-1.5 -mr-1 -ml-2 flex h-6 w-5 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing"
            >
              <GripVertical className="size-4" />
            </span>
          ) : null
          return (
            <li
              key={item.key}
              draggable={fine && armed === index}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move"
                event.dataTransfer.setData("text/plain", item.key)
                setDragging(index)
              }}
              onDragOver={(event) => over(event, index)}
              onDrop={drop}
              onDragEnd={reset}
              className={cn("relative transition-opacity", dragging === index && "opacity-50")}
            >
              {gap === index && dragging !== null ? (
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-[7px] h-0.5 rounded-full bg-primary" />
              ) : null}
              {renderStep(item, index, handle)}
              {gap === items.length && index === items.length - 1 && dragging !== null ? (
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 -bottom-[7px] h-0.5 rounded-full bg-primary" />
              ) : null}
            </li>
          )
        })}
      </ol>
      {onAdd ? (
        <Button variant="outline" className="self-start" onClick={onAdd}>
          <Plus />
          {addLabel}
        </Button>
      ) : null}
    </div>
  )
}
