// On a phone the App's sidebar is the host's sheet. Tapping a page in it opens
// that page and closes the sheet, and no page is wider than
// the screen. Runs at the viewport the runner gives (390 px wide).
export default async (_page, args, h) => {
  const { own } = h
  const base = h.app(args.app)
  const sheetOpen = () => own.evaluate(() => Boolean(document.querySelector('[data-slot=sidebar][data-mobile=true]')))
  const overflow = () =>
    own.evaluate(() => {
      const root = document.documentElement
      return { width: root.clientWidth, content: Math.max(root.scrollWidth, document.body.scrollWidth) }
    })

  h.step('open the Tasks page')
  await h.open(`${base}/tasks`)
  const first = await overflow()
  await h.check('tasks: no horizontal overflow', first.content <= first.width, `${first.content} in ${first.width} px`)

  for (const target of args.pages) {
    h.step(`${target}: open the sheet`)
    await own.locator('button[aria-label="Open sidebar"]').first().click({ timeout: 5000 })
    if (!(await h.check(`${target}: sheet opens`, await h.until(sheetOpen, 3000), h.path()))) {
      return
    }
    h.step(`${target}: tap the page in the sheet`)
    await own
      .locator(`[data-slot=sidebar][data-mobile=true] a[href="${base}/${target}"]`)
      .first()
      .click({ timeout: 5000 })
    const moved = await h.until(async () => h.path().split('?')[0] === `${base}/${target}`, 5000)
    const closed = await h.until(async () => !(await sheetOpen()), 3000)
    await h.check(
      `${target}: tap opens it and closes the sheet`,
      moved && closed,
      `${h.path()}${closed ? '' : ', sheet still open'}`,
    )
    h.step(`${target}: measure the width`)
    await h.quiet()
    const size = await overflow()
    await h.check(
      `${target}: no horizontal overflow`,
      size.content <= size.width,
      `${size.content} in ${size.width} px`,
    )
  }
  await h.check('no page errors', h.errors.length === 0, h.errors.slice(0, 3).join(' | ') || 'none')
}
