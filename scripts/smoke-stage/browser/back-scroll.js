// Back restores the Tasks list where the reader left it, a pane that mounts
// late included. Scroll the list to `args.top`, move away with a
// real click (`args.via`: `task` opens a task the reader can see, `board`
// takes the sidebar's Board link), then use the browser's Back.
export default async (_page, args, h) => {
  const { own } = h
  const base = h.app(args.app)
  // The list pane: the page's scroll area that holds task links and has the
  // most room to scroll. Found afresh each time, since Back may remount it.
  await own.addInitScript(() => {
    globalThis.smokeListPane = () =>
      [...document.querySelectorAll('[data-slot=scroll-area-viewport]')]
        .filter((element) => element.querySelector('a[href*="/task/"]'))
        .sort((a, b) => b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight))[0] ?? null
  })
  const pane = () =>
    own.evaluate(() => {
      const found = globalThis.smokeListPane()
      return found ? { top: Math.round(found.scrollTop), room: found.scrollHeight - found.clientHeight } : null
    })
  const scrollTo = (top) =>
    own.evaluate((top) => {
      globalThis.smokeListPane().scrollTop = top
    }, top)
  // After Back, the list lays out again before it can be restored: wait for
  // the position (up to 5 s), then read it once more a second later.
  const restored = async () => {
    await h.until(async () => (await pane())?.top === args.top, 5000)
    await h.sleep(1000)
    return (await pane())?.top ?? null
  }
  const back = async (expect) => {
    await own.evaluate(() => history.back())
    return h.until(async () => expect(h.path()), 5000)
  }
  const forward = async (expect) => {
    await own.evaluate(() => history.forward())
    return h.until(async () => expect(h.path()), 5000)
  }
  const onList = (path) => path.split('?')[0] === `${base}/tasks`

  h.step('open the Tasks page')
  await h.open(`${base}/tasks`)
  h.step('wait for the list to lay out')
  const ready = await h.until(async () => ((await pane())?.room ?? 0) >= args.top, 15000)
  if (!(await h.check(`list can scroll to ${args.top}`, ready, `room ${(await pane())?.room ?? 'no list pane'}`))) {
    return
  }

  h.step(`scroll the list to ${args.top}`)
  await scrollTo(args.top)
  await h.sleep(500)
  if (!(await h.check(`list at ${args.top}`, (await pane())?.top === args.top, `at ${(await pane())?.top}`))) {
    return
  }

  if (args.via === 'task') {
    h.step('click a task the reader can see')
    const box = await own.evaluate(() => {
      const found = globalThis.smokeListPane()
      const frame = found.getBoundingClientRect()
      const link = [...found.querySelectorAll('a[href*="/task/"]')].find((a) => {
        const r = a.getBoundingClientRect()
        return r.width > 0 && r.top > frame.top + 30 && r.bottom < frame.bottom - 30
      })
      if (!link) {
        return null
      }
      const r = link.getBoundingClientRect()
      return { x: r.left + Math.min(15, r.width / 2), y: r.top + r.height / 2, href: link.getAttribute('href') }
    })
    if (!(await h.check('a visible task to open', box, box?.href ?? 'none in view'))) {
      return
    }
    await own.mouse.click(box.x, box.y)
    const opened = await h.until(async () => h.path().includes('/task/'), 5000)
    if (!(await h.check('task opens', opened, h.path()))) {
      return
    }
    await h.sleep(700)

    h.step('Back to the list')
    await back(onList)
    const first = await restored()
    await h.check(`Back gives ${args.top}`, first === args.top, `${h.path()} at ${first}`)

    h.step('Forward to the task')
    const again = await forward((path) => path.includes('/task/'))
    await h.check('Forward opens the task', again, h.path())
    await h.sleep(700)

    h.step('Back to the list again')
    await back(onList)
    const second = await restored()
    await h.check(`Back again gives ${args.top}`, second === args.top, `${h.path()} at ${second}`)
  } else {
    h.step('click the sidebar link to Board')
    const link = own.locator(`[data-slot=tasks-sidebar] a[href="${base}/board"]`).first()
    await link.click({ timeout: 5000 })
    const moved = await h.until(async () => h.path().split('?')[0] === `${base}/board`, 5000)
    if (!(await h.check('Board opens', moved, h.path()))) {
      return
    }
    await h.sleep(700)

    h.step('Back to the list')
    await back(onList)
    const top = await restored()
    await h.check(`Back gives ${args.top}`, top === args.top, `${h.path()} at ${top}`)
  }
  await h.check('no page errors', h.errors.length === 0, h.errors.slice(0, 3).join(' | ') || 'none')
}
