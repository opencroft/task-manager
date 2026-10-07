// The `tasks` App: the project's key and controls in the host's title bar, its
// pages in the host's sidebar (with the page's own section under them, on
// Workflows its workflow list), and the page the path names. `/task/KEY-N` opens a task's
// details, `/settings/<section>` the project's settings; anything unknown
// falls back to the default page. `?peek=KEY-N` on a page opens that task in
// the peek beside it.

import { AppActions, type AppComponentProps, AppSidebar, AppTitle } from '@opencroft/client'
import { cn } from 'cn'
import { Settings2 } from 'lucide-react'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { TaskPeekLayout } from '@/components/ui/tasks/task-peek-panel'
import { TasksSidebar } from '@/components/ui/tasks/tasks-nav'

import { PROJECT_KEY_PATTERN } from '../../shared/types'
import { ProjectChat } from '../chat/project-chat'
import { ProjectInbox } from '../inbox/project-inbox'
import { hrefFor, navigate, useAppRouter, useTasksLocation } from '../lib/router'
import { TaskPage } from '../pages/task-page'
import { TaskPeek } from '../pages/task-peek'
import { SETTINGS_ROUTE, SettingsPage, settingsHref } from '../settings/settings-page'
import { ProjectProvider } from './project'
import { DEFAULT_ROUTE, routes } from './routes'
import { ShortcutsProvider } from './shortcuts'
import { SidebarSectionProvider } from './sidebar-section'
import { PageScrollerContext, usePageScrollMemory } from './page-scroll'
import { peekKeyOf, useNewTabClicks } from './task-opener'

export function TasksApp({ instanceId, params }: AppComponentProps) {
  const projectKey = (params.id ?? '').trim()
  // First, so every page below already addresses the App's own paths.
  useAppRouter()
  const location = useTasksLocation()
  const [section] = location.segments
  const route = routes.find((candidate) => candidate.id === section)
  const taskKey = section === 'task' ? location.segments[1] : undefined
  const settings = section === SETTINGS_ROUTE
  const peekKey = peekKeyOf(location)
  // Tasks, Board, Timeline and Settings fill the page pane and scroll inside themselves; the other pages grow it.
  const fills = !taskKey && (settings || Boolean(route?.fills))
  // The pane every page scrolls in; Back and Forward return it to where it was.
  const pageScrollRef = useRef<HTMLDivElement>(null)
  // A page's own scroller (the Tasks table's), kept and restored in the pane's place while it is mounted.
  const pageOwnScrollRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return pageOwnScrollRef.current ?? pageScrollRef.current
      },
    }),
    [],
  )
  usePageScrollMemory(scrollerRef)
  useNewTabClicks()
  // The sidebar's slot for the page's own section; there only on a page that has one.
  const [sectionSlot, setSectionSlot] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!route && !taskKey && !settings) {
      navigate(hrefFor([DEFAULT_ROUTE]), { replace: true })
    }
  }, [route, taskKey, settings])

  if (!PROJECT_KEY_PATTERN.test(projectKey)) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        This app's project key "{projectKey}" is not valid. Edit the app and set a key like TASK.
      </div>
    )
  }

  const Page = route?.component
  const active = taskKey || settings ? null : (route?.id ?? null)
  const pages = routes.map((r) => ({ id: r.id, label: r.label, icon: r.icon, href: hrefFor([r.id]) }))
  const place = {
    page: taskKey ? null : settings ? 'Settings' : (route?.label ?? null),
    path: `/${location.segments.join('/')}`,
    taskKey: (taskKey ?? peekKey)?.toUpperCase() ?? null,
  }
  return (
    <ProjectProvider instanceId={instanceId} projectKey={projectKey}>
      <ShortcutsProvider>
        {/* The project's agent chat around the whole App, so every page sits in its dock. */}
        <ProjectChat instanceId={instanceId} projectKey={projectKey} place={place}>
          <AppTitle>{projectKey}</AppTitle>
          <AppActions>
            <ProjectInbox instanceId={instanceId} />
            <Button
              variant={settings ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label="Project settings"
              title="Project settings"
              aria-current={settings ? 'page' : undefined}
              nativeButton={false}
              render={<a href={settingsHref()} />}
            >
              <Settings2 />
            </Button>
          </AppActions>
          {/* One path on every device: a pushed panel on a wide screen, the host's sheet on a phone. */}
          <AppSidebar mode="push">
            <TasksSidebar items={pages} active={active}>
              {active === 'workflows' ? <div ref={setSectionSlot} className="flex min-h-0 flex-1 flex-col" /> : null}
            </TasksSidebar>
          </AppSidebar>
          <SidebarSectionProvider value={sectionSlot}>
            <main className="flex h-full min-h-0 w-full flex-1 flex-col">
              {/* The layout's page pane is the page's scroller. A page that fills it and scrolls inside itself (Board, Timeline, Settings) is bounded by it; a longer one grows the pane's content and the pane scrolls. */}
              <TaskPeekLayout
                storageKey={`tasks:${instanceId}:peek-size`}
                pageScrollRef={pageScrollRef}
                pageFills={fills}
                peek={peekKey ? <TaskPeek taskKey={peekKey} /> : null}
              >
                <PageScrollerContext.Provider value={pageOwnScrollRef}>
                  <div className={cn('flex flex-1 flex-col', fills && 'min-h-0')}>
                    {taskKey ? (
                      <TaskPage key={taskKey} taskKey={taskKey.toUpperCase()} />
                    ) : settings ? (
                      <SettingsPage section={location.segments[1]} />
                    ) : Page ? (
                      <Page />
                    ) : null}
                  </div>
                </PageScrollerContext.Provider>
              </TaskPeekLayout>
            </main>
          </SidebarSectionProvider>
        </ProjectChat>
      </ShortcutsProvider>
    </ProjectProvider>
  )
}
