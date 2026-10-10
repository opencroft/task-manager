// A page of the App loads with no page errors, then the App makes no call of
// its own while nobody touches it (a refetch loop shows only this way).
// `args.page` is a page id, or `task` for the first task on the Tasks page.
export default async (_page, args, h) => {
  let address = `${h.app(args.app)}/${args.page}`
  if (args.page === 'task') {
    h.step('find a task on the Tasks page')
    await h.open(`${h.app(args.app)}/tasks`)
    const href = await h.own.evaluate(() => document.querySelector('main a[href*="/task/"]')?.getAttribute('href'))
    if (!(await h.check('a task to open', href, href ?? 'no task link on the Tasks page'))) {
      return
    }
    address = href
  }

  h.step(`open ${address}`)
  const settled = await h.open(address)
  const mounted = await h.own.evaluate(() => Boolean(document.querySelector('[data-slot=tasks-sidebar]')))
  await h.check(
    'loads',
    settled && mounted && h.path().startsWith(address),
    `${h.path()}${settled ? '' : ', not settled in 20 s'}${mounted ? '' : ', no App sidebar'}`,
  )

  // A loop slower than the 5 s watched goes unseen: this can miss a bug, never
  // invent one.
  h.step('idle 5 s')
  const idle = await h.idle(5000)
  const onLoad = h.calls.filter((call) => call.kind === 'app').length
  await h.check(
    '0 App calls in 5 s idle',
    idle.app.length === 0,
    idle.app.length > 0 ? h.tally(idle.app) : `0 (${onLoad} on load)`,
  )
  // The host's own polling (e.g. the chat dock's activity poll) is the host's
  // business, not the App's: shown, never failed.
  h.note('host calls in 5 s idle', idle.host.length > 0 ? h.tally(idle.host) : 'none')
  await h.check('no page errors', h.errors.length === 0, h.errors.slice(0, 3).join(' | ') || 'none')
}
