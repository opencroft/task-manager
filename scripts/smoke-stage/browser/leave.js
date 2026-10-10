// Leaving the App stays left: the App, still mounted for one render, must not
// read the host's new address as one of its pages and route back.
// `args.way` is one of the three ways out: `switcher` (the title bar's App
// switcher, to `args.switchTo`), `graph` (the title bar's graph link), or
// `back` (Back and Forward between the App and `args.otherApp`).
export default async (_page, args, h) => {
  const { own } = h
  const base = h.app(args.app)
  const board = `${base}/board`
  const inApp = (path) => path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`)
  // After the move, the page reaches an address outside the App and never
  // comes back into it.
  const staysOut = (trail, target) => {
    const out = trail.findIndex((path) => !inApp(path))
    return out >= 0 && trail.slice(out).every((path) => !inApp(path)) && trail[trail.length - 1].startsWith(target)
  }
  // Once back on the Board, the page stays there.
  const staysOn = (trail) => {
    const at = trail.findIndex((path) => path.split('?')[0] === board)
    return at >= 0 && trail.slice(at).every((path) => path.split('?')[0] === board)
  }
  const shown = (trail) => trail.join(' → ')

  if (args.way === 'switcher') {
    h.step('open My work')
    await h.open(`${base}/my-work`)
    const target = h.app(args.switchTo)
    h.step(`find the title-bar switcher listing ${target}`)
    const triggers = own.locator('[data-slot=title-bar] button[data-slot=popover-trigger]')
    let option = null
    for (let i = 0; i < (await triggers.count()) && !option; i++) {
      await triggers.nth(i).click({ timeout: 3000 })
      await h.sleep(400)
      const candidate = own.locator(`[data-slot=popover-content] a[href="${target}"]`).first()
      if ((await candidate.count()) > 0) {
        option = candidate
      } else {
        await own.keyboard.press('Escape')
        await h.sleep(200)
      }
    }
    if (!(await h.check('title bar lists the other App', option, option ? target : 'no switcher lists it'))) {
      return
    }
    h.step(`choose ${target}`)
    await option.click({ timeout: 3000 })
    const trail = await h.trail()
    await h.check('App switcher leaves', staysOut(trail, target), shown(trail))
  } else if (args.way === 'graph') {
    h.step('open the Board')
    await h.open(board)
    const graph = `/space/${args.space}`
    h.step(`click the title-bar link to ${graph}`)
    await own.locator(`a[href="${graph}"]`).first().click({ timeout: 5000 })
    const trail = await h.trail()
    await h.check('graph link leaves', staysOut(trail, graph), shown(trail))
  } else {
    const other = h.app(args.otherApp)
    h.step('open the Board')
    await h.open(board)
    h.step(`click the title-bar link to ${other}`)
    await own.locator(`a[href="${other}"]`).first().click({ timeout: 5000 })
    const out = await h.trail()
    if (!(await h.check('link to the other App leaves', staysOut(out, other), shown(out)))) {
      return
    }

    h.step('Back into the App')
    await own.evaluate(() => history.back())
    const backIn = await h.trail()
    await h.check('Back returns to the Board, no bounce', staysOn(backIn), shown(backIn))

    h.step('Forward out again')
    await own.evaluate(() => history.forward())
    const forwardOut = await h.trail()
    await h.check('Forward leaves again', staysOut(forwardOut, other), shown(forwardOut))

    h.step('Back into the App again')
    await own.evaluate(() => history.back())
    const backAgain = await h.trail()
    await h.check('Back again returns to the Board', staysOn(backAgain), shown(backAgain))
  }
  await h.check('no page errors', h.errors.length === 0, h.errors.slice(0, 3).join(' | ') || 'none')
}
