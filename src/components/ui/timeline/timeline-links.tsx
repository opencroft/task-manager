import { type SVGProps, useMemo, useState } from 'react'

import { ItemContextMenu, type ItemMenuEntries } from '@/components/ui/tasks/item-menu'
import { cn } from '@/lib/utils'

import { type LinkedTask, linkConflict, linkId, type TimelineLink } from './timeline-links-model'
import { toDay } from './timeline-scale'

/** Horizontal room an arrow takes leaving a bar and entering one. */
const STUB = 8
const RADIUS = 4

export interface TimelineLinksProps {
  links: TimelineLink[]
  /** The tasks; only key, dates and status are read, so the timeline's own list passes as it is. */
  tasks: LinkedTask[]
  /** The top of each visible task row, in the layer's pixels. A task without one is not drawn. */
  rowTops: Record<string, number>
  /** Day number at x = 0, and the zoom: the same space the bars are drawn in. */
  origin: number
  pxPerDay: number
  width: number
  height: number
  /** Where a bar sits in its row; the defaults match the timeline's bars. */
  barTop?: number
  barHeight?: number
  /** A hovered or selected task: its links are drawn strong and the others dim. */
  emphasisKey?: string | null
  /** Pressing a link. Without it the links do not take the pointer at all. */
  onLinkClick?: (link: TimelineLink) => void
  /** A link's menu, on right-click or a long press on its arrow. */
  linkMenu?: (link: TimelineLink) => ItemMenuEntries
  /** A link being dragged out of a blocker's end: to a point in the layer, or to a task it is over. */
  draft?: { from: string; to: { x: number; y: number } | string } | null
  className?: string
}

type Point = [number, number]

/** A polyline with its inner corners rounded. */
function roundedPath(points: Point[]): string {
  let d = `M${points[0][0]},${points[0][1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1]
    const [cx, cy] = points[i]
    const [nx, ny] = points[i + 1]
    const inLength = Math.hypot(cx - px, cy - py)
    const outLength = Math.hypot(nx - cx, ny - cy)
    const r = Math.min(RADIUS, inLength / 2, outLength / 2)
    if (r <= 0) {
      d += ` L${cx},${cy}`
      continue
    }
    const ax = cx - ((cx - px) / inLength) * r
    const ay = cy - ((cy - py) / inLength) * r
    const bx = cx + ((nx - cx) / outLength) * r
    const by = cy + ((ny - cy) / outLength) * r
    d += ` L${ax},${ay} Q${cx},${cy} ${bx},${by}`
  }
  const [lx, ly] = points[points.length - 1]
  return `${d} L${lx},${ly}`
}

/**
 * The route from a blocker's end to a blocked task's start. With room between
 * them it is one elbow; otherwise it leaves to the right, runs back along the
 * gap beside the blocked bar, and enters it from the left.
 */
function route(x1: number, y1: number, x2: number, y2: number, gapY: number): Point[] {
  if (x2 - x1 >= STUB * 2) {
    return [
      [x1, y1],
      [x1 + STUB, y1],
      [x1 + STUB, y2],
      [x2, y2],
    ]
  }
  return [
    [x1, y1],
    [x1 + STUB, y1],
    [x1 + STUB, gapY],
    [x2 - STUB, gapY],
    [x2 - STUB, y2],
    [x2, y2],
  ]
}

/** The arrow's end, drawn short of the bar so the head sits on its edge. */
function arrowHead(x: number, y: number): string {
  return `M${x},${y} L${x - 5},${y - 3.5} L${x - 5},${y + 3.5} Z`
}

interface DrawnLink {
  link: TimelineLink
  id: string
  d: string
  head: string
  conflict: boolean
  mark: Point | null
}

/**
 * The dependency arrows over the timeline's lanes. Pure: it draws from the
 * positions it is given and measures nothing. Place it over the lanes, in the
 * same scrolled space as the bars, so x = (day - origin) * pxPerDay.
 */
export function TimelineLinks({
  links,
  tasks,
  rowTops,
  origin,
  pxPerDay,
  width,
  height,
  barTop = 4,
  barHeight = 20,
  emphasisKey = null,
  onLinkClick,
  linkMenu,
  draft = null,
  className,
}: TimelineLinksProps) {
  const [hovered, setHovered] = useState<string | null>(null)

  const index = useMemo(() => {
    const out: Record<string, LinkedTask> = {}
    for (const task of tasks) {
      out[task.key] = task
    }
    return out
  }, [tasks])

  const centreY = (key: string) => rowTops[key] + barTop + barHeight / 2
  const endX = (task: LinkedTask) => (toDay(task.endDate as string) + 1 - origin) * pxPerDay
  const startX = (task: LinkedTask) => (toDay(task.startDate as string) - origin) * pxPerDay
  const drawable = (task: LinkedTask | undefined): task is LinkedTask =>
    task !== undefined && task.startDate !== null && task.endDate !== null && rowTops[task.key] !== undefined

  const drawn: DrawnLink[] = []
  for (const link of links) {
    const blocker = index[link.from]
    const blocked = index[link.to]
    if (!drawable(blocker) || !drawable(blocked) || link.from === link.to) {
      continue
    }
    const x1 = endX(blocker)
    const y1 = centreY(link.from)
    const x2 = startX(blocked)
    const y2 = centreY(link.to)
    // The gap to run back along: just above the blocked bar when it is lower, just below it when it is higher.
    const gapY = y2 > y1 ? rowTops[link.to] + barTop / 2 : rowTops[link.to] + barTop + barHeight + barTop / 2
    const conflict = linkConflict(blocker, blocked)
    drawn.push({
      link,
      id: linkId(link),
      d: roundedPath(route(x1, y1, x2 - 4, y2, gapY)),
      head: arrowHead(x2, y2),
      conflict,
      mark: conflict ? [x2, rowTops[link.to] + barTop] : null,
    })
  }

  const focus = hovered ?? null
  const strong = (item: DrawnLink) =>
    item.id === focus || (emphasisKey !== null && (item.link.from === emphasisKey || item.link.to === emphasisKey))
  const dimming = focus !== null || (emphasisKey !== null && drawn.some((item) => item.link.from === emphasisKey || item.link.to === emphasisKey))

  let draftPath: { d: string; head: string } | null = null
  if (draft) {
    const blocker = index[draft.from]
    if (drawable(blocker)) {
      const x1 = endX(blocker)
      const y1 = centreY(draft.from)
      const target = typeof draft.to === 'string' ? index[draft.to] : undefined
      if (typeof draft.to === 'string') {
        if (drawable(target)) {
          const x2 = startX(target)
          const y2 = centreY(target.key)
          const gapY = y2 > y1 ? rowTops[target.key] + barTop / 2 : rowTops[target.key] + barTop + barHeight + barTop / 2
          draftPath = { d: roundedPath(route(x1, y1, x2 - 4, y2, gapY)), head: arrowHead(x2, y2) }
        }
      } else {
        const { x, y } = draft.to
        draftPath = { d: `M${x1},${y1} L${x1 + STUB},${y1} L${x},${y}`, head: '' }
      }
    }
  }

  // Links under emphasis are drawn last, so they sit on top of the others.
  const ordered = [...drawn].sort((a, b) => Number(strong(a)) - Number(strong(b)) || Number(a.conflict) - Number(b.conflict))

  return (
    <svg
      data-slot='timeline-links'
      aria-hidden='true'
      width={width}
      height={height}
      className={cn('pointer-events-none absolute top-0 left-0 overflow-visible', className)}
    >
      {ordered.map((item) => {
        const isStrong = strong(item)
        const title = <title>{`${item.link.from} blocks ${item.link.to}${item.conflict ? ': starts before its blocker ends' : ''}`}</title>
        const hit: SVGProps<SVGPathElement> = {
          d: item.d,
          fill: 'none',
          stroke: 'transparent',
          strokeWidth: 10,
          style: { pointerEvents: 'stroke', cursor: onLinkClick ? 'pointer' : 'context-menu' },
          onPointerEnter: () => setHovered(item.id),
          onPointerLeave: () => setHovered((current) => (current === item.id ? null : current)),
          onPointerDown: (event) => event.stopPropagation(),
          onClick: (event) => {
            event.stopPropagation()
            onLinkClick?.(item.link)
          },
        }
        const tone = item.conflict ? 'text-red-500 dark:text-red-400' : isStrong ? 'text-foreground' : 'text-muted-foreground'
        return (
          <g
            key={item.id}
            data-link={item.id}
            data-conflict={item.conflict || undefined}
            className={cn(tone, 'transition-opacity', dimming && !isStrong ? 'opacity-30' : item.conflict || isStrong ? 'opacity-100' : 'opacity-70')}
          >
            <path d={item.d} fill='none' stroke='currentColor' strokeWidth={isStrong ? 2 : 1.25} strokeLinejoin='round' />
            <path d={item.head} fill='currentColor' />
            {item.mark ? (
              <g transform={`translate(${item.mark[0]},${item.mark[1]})`}>
                <circle r={6} className='fill-red-500 stroke-background dark:fill-red-400' strokeWidth={1.5} />
                <path d='M0,-3 L0,0.5 M0,2.6 L0,2.7' className='stroke-white dark:stroke-background' strokeWidth={1.6} strokeLinecap='round' />
              </g>
            ) : null}
            {linkMenu ? (
              <ItemContextMenu entries={linkMenu(item.link)} render={<path {...hit} />}>
                {title}
              </ItemContextMenu>
            ) : onLinkClick ? (
              <path {...hit}>{title}</path>
            ) : null}
          </g>
        )
      })}
      {draftPath ? (
        <g data-link='draft' className='text-primary'>
          <path d={draftPath.d} fill='none' stroke='currentColor' strokeWidth={1.5} strokeDasharray='4 3' />
          {draftPath.head ? <path d={draftPath.head} fill='currentColor' /> : null}
        </g>
      ) : null}
    </svg>
  )
}
