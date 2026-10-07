// Routing inside the App page. The App's pages are real paths under the
// instance's address — `…/app/<app>/tasks?status=To%20Do`,
// `…/app/<app>/task/TASK-12` — handed to the App by the host and moved
// between through the host's App router, so a page change is a history
// entry, a reload or a shared link lands on the same page, and nothing
// remounts or scrolls. Everything else in the App routes through this file.
//
// Links elsewhere in the App are plain `<a href={hrefFor(...)}>`: `useAppRouter`
// turns a plain click on one into an in-App move, and leaves Ctrl/Cmd-, Shift-
// and middle-clicks to the browser.

import { useAppAddressHref, useAppHref, useAppLocation, useAppNavigate, useOpenApp } from '@opencroft/client'
import { useCallback, useEffect, useMemo, useRef } from 'react'

export interface TasksLocation {
  /** Path segments after the instance's address, e.g. ['task', 'TASK-12']. */
  segments: string[]
  query: URLSearchParams
}

// The instance's address and the host's navigate, from the App's root (see
// useAppRouter). Module state because much of the App opens pages from event
// handlers and plain functions rather than from components.
let base = ''
let hostNavigate: ReturnType<typeof useAppNavigate> | null = null
// Pages of other task-manager Apps, which answers across projects link to.
let hostAddressHref: ReturnType<typeof useAppAddressHref> | null = null
let hostOpenApp: ReturnType<typeof useOpenApp> | null = null

/**
 * An address with the location in the hash (`#/tasks?status=Done`) names the
 * page its hash does: it is read as that page until useAppRouter replaces it
 * with the path.
 */
function legacyHashPath(path: string): string | null {
  return path === '/' && window.location.hash.startsWith('#/') ? window.location.hash.slice(1) : null
}

function locationOf(path: string, search: string): TasksLocation {
  const [legacyPath, legacySearch = ''] = legacyHashPath(path)?.split('?') ?? []
  return {
    segments: (legacyPath ?? path).split('/').filter(Boolean).map(decodeURIComponent),
    query: new URLSearchParams(legacyPath === undefined ? search : legacySearch),
  }
}

/** The App path of an address this App wrote, e.g. `/task/TASK-12?tab=activity`. */
function appPathOf(href: string): string {
  const rest = href.slice(base.length)
  return rest.startsWith('/') ? rest : `/${rest}`
}

/**
 * Whether the browser is at one of this App's own addresses. It is not while
 * the host moves elsewhere — another App, the graph, Back out of the App —
 * and the App, still mounted for that moment, then sees a location that is
 * not one of its pages. It must neither read that as a page nor answer it.
 */
function atOwnAddress(): boolean {
  const { pathname } = window.location
  return pathname === base || pathname.startsWith(`${base}/`)
}

/** The location as it is now, for code that acts on it rather than renders it. */
export function currentLocation(): TasksLocation {
  return locationOf(window.location.pathname.slice(base.length) || '/', window.location.search)
}

/** The address of a page in this App. */
export function hrefFor(segments: string[], query?: URLSearchParams | Record<string, string>): string {
  const path = segments.map(encodeURIComponent).join('/')
  const params = query instanceof URLSearchParams ? query : new URLSearchParams(query ?? {})
  const search = params.toString()
  return `${base}${path ? `/${path}` : ''}${search ? `?${search}` : ''}`
}

// Set while a move the App asked for is under way, so a location change can be
// told apart from one the browser made (Back, Forward) without depending on
// which popstate listener runs first. See takeAppMove.
let appMove = false

/** Navigate within the App. `replace` rewrites the current history entry instead of adding one. */
export function navigate(href: string, options: { replace?: boolean } = {}): void {
  // Off the App's addresses the host is taking the browser elsewhere, and a
  // move now (a page's default, a query tidy-up) would pull it back.
  if (!atOwnAddress() || href === `${window.location.pathname}${window.location.search}`) {
    return
  }
  appMove = true
  hostNavigate?.(appPathOf(href), { replace: options.replace })
}

/**
 * Whether the location change being handled now was one the App made through
 * `navigate`, rather than the browser's Back or Forward. Answers once per move:
 * the caller that reacts to a location change takes it.
 */
export function takeAppMove(): boolean {
  const moved = appMove
  appMove = false
  return moved
}

const appPath = (segments: string[]) => `/${segments.map(encodeURIComponent).join('/')}`

/** Whether `app` (`<space>.<app>`, as rows across projects carry it) is this App. */
export function isOwnApp(app: string): boolean {
  return hostAddressHref?.(app, '/') === base
}

/** The address of a page in another App. */
export function hrefIn(app: string, segments: string[]): string {
  return hostAddressHref ? hostAddressHref(app, appPath(segments)) : ''
}

/** Moves to a page in another App, with a history entry, so Back returns here. */
export function navigateIn(app: string, segments: string[]): void {
  hostOpenApp?.(app, appPath(segments))
}

/** Absolute link to a location in this App, for "copy link". */
export function absoluteLink(href: string): string {
  return `${window.location.origin}${href}`
}

export function useTasksLocation(): TasksLocation {
  const { path, search } = useAppLocation()
  // The search's string is its identity: the object is new every render.
  const searchString = search.toString()
  const inside = atOwnAddress()
  const location = useMemo(() => locationOf(path, searchString), [path, searchString])
  // While the host leaves the App, the page stays the one the App was on.
  const last = useRef(location)
  if (inside) {
    last.current = location
  }
  return last.current
}

/**
 * Writes several query parameters of the current route in one move; null or
 * '' removes one. Adds a history entry unless `replace`.
 */
export function navigateQuery(patch: Record<string, string | null>, options: { replace?: boolean } = {}): void {
  const current = currentLocation()
  for (const [name, value] of Object.entries(patch)) {
    if (value === null || value === '') {
      current.query.delete(name)
    } else {
      current.query.set(name, value)
    }
  }
  navigate(hrefFor(current.segments, current.query), options)
}

/** A query parameter of the current route as state; writing it replaces the history entry. */
export function useQueryParam(name: string): [string | null, (value: string | null) => void] {
  const location = useTasksLocation()
  const value = location.query.get(name)
  const set = useCallback((next: string | null) => navigateQuery({ [name]: next }, { replace: true }), [name])
  return [value, set]
}

function isPlainClick(event: MouseEvent, anchor: HTMLAnchorElement): boolean {
  const target = anchor.getAttribute('target')
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) &&
    (target === null || target === '_self') &&
    !anchor.hasAttribute('download')
  )
}

/** Moves the App on a plain click of a link to one of its own pages. */
function followAppLink(event: MouseEvent) {
  const anchor = (event.target as Element | null)?.closest?.('a[href]')
  if (!(anchor instanceof HTMLAnchorElement) || !isPlainClick(event, anchor)) {
    return
  }
  const url = new URL(anchor.href)
  const own = url.origin === window.location.origin && (url.pathname === base || url.pathname.startsWith(`${base}/`))
  if (own) {
    event.preventDefault()
    navigate(`${url.pathname}${url.search}`)
  }
}

/** Connects this module to the host's App router. The App's root calls it once, before rendering its pages. */
export function useAppRouter(): void {
  const appNavigate = useAppNavigate()
  const appHref = useAppHref()
  base = appHref('/')
  hostNavigate = appNavigate
  hostAddressHref = useAppAddressHref()
  hostOpenApp = useOpenApp()

  useEffect(() => {
    const legacy = legacyHashPath(window.location.pathname.slice(base.length) || '/')
    if (legacy) {
      appNavigate(legacy, { replace: true })
    }
    document.addEventListener('click', followAppLink)
    return () => document.removeEventListener('click', followAppLink)
  }, [appNavigate])
}
