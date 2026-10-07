// Shared set-up for every smoke check, run by the browser server's
// `browser_run_code_unsafe`. This file is sent as source text: it is one
// function expression with no imports and nothing captured from outside, and
// the sandbox has no `setTimeout` or `URL` (waits go through the driver).
//
// It opens the check's own browser context, signed in with the storage state
// of the account the browser is signed in as, and records what every check
// reports on: the App's server calls, page errors, and a row per assertion.
async (page, args) => {
  const origin = args.origin || page.url().split('/').slice(0, 3).join('/')
  const ctx = await page
    .context()
    .browser()
    .newContext({
      storageState: await page.context().storageState(),
      viewport: args.viewport || { width: 1280, height: 800 },
    })
  const sleep = (ms) => ctx.waitForEvent('close', { timeout: ms }).catch(() => {})
  const own = await ctx.newPage()

  // Server calls. The App's own are its actions (a server-function POST whose
  // body names the action, "s":"<action>") and its HTTP routes under
  // /api/ext/<extension>/. Every other server function is the host's, named
  // by its export: the sign-in gate on each page change (getAuthState), the
  // chat dock's activity poll (listSessionActivity), and so on.
  // The id in a server function's URL is base64 JSON naming its file and
  // export. Decoded by hand: the sandbox has no Buffer, atob or TextDecoder.
  const fromBase64 = (text) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let value = 0
    let bits = 0
    let out = ''
    for (const char of text.replace(/-/g, '+').replace(/_/g, '/')) {
      const index = alphabet.indexOf(char)
      if (index >= 0) {
        value = ((value << 6) | index) & 0xffffff
        bits += 6
        if (bits >= 8) {
          bits -= 8
          out += String.fromCharCode((value >> bits) & 0xff)
        }
      }
    }
    return out
  }
  const hostName = (url) => {
    const text = fromBase64(decodeURIComponent(url.split('/_serverFn/')[1]?.split(/[?/]/)[0] ?? ''))
    return text.match(/"export":"([A-Za-z0-9$]+?)(?:_createServerFn[^"]*)?"/)?.[1] ?? text.match(/\/([^/"]+)\.ts/)?.[1] ?? 'host'
  }
  const calls = []
  const inflight = new Set()
  own.on('request', (request) => {
    // A throw in a Playwright event handler takes the whole call down (and
    // with it the browser session), so nothing here may escape.
    try {
      const url = request.url()
      let call = null
      if (url.includes(`/api/ext/${args.extension}/`)) {
        call = { kind: 'app', name: `route ${url.split(`/api/ext/${args.extension}/`)[1].split('?')[0]}` }
      } else if (url.includes('/_serverFn/')) {
        const action = (request.postData() || '').match(/"s":"([a-z]+_[a-z_]+)"/)?.[1]
        call = action ? { kind: 'app', name: action } : { kind: 'host', name: hostName(url) }
      }
      if (call) {
        calls.push({ at: Date.now(), ...call })
        inflight.add(request)
      }
    } catch {
      calls.push({ at: Date.now(), kind: 'host', name: 'unreadable' })
    }
  })
  const settle = (request) => inflight.delete(request)
  own.on('requestfinished', settle)
  own.on('requestfailed', settle)

  const errors = []
  own.on('pageerror', (error) => errors.push(String(error).slice(0, 200)))

  const rows = []
  let step = 'start'

  const h = {
    own,
    origin,
    sleep,
    calls,
    errors,
    rows,
    /** The address of an App in the smoke space: `/space/<space>/app/<slug>`. */
    app: (slug) => `/space/${args.space}/app/${slug}`,
    path: () => own.url().replace(origin, ''),
    /** Names what the check is doing, so a failure says where it stopped. */
    step: (name) => {
      step = name
    },
    currentStep: () => step,
    async until(test, ms) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (await test().catch(() => false)) {
          return true
        }
        await sleep(150)
      }
      return false
    },
    /** Waits until no server call has been in flight for `ms` (at most `cap`). */
    async quiet(ms = 1200, cap = 20000) {
      const end = Date.now() + cap
      let since = Date.now()
      while (Date.now() < end) {
        if (inflight.size > 0) {
          since = Date.now()
        } else if (Date.now() - since >= ms) {
          return true
        }
        await sleep(100)
      }
      return false
    },
    /** Opens an address and waits for the page to settle: content in `main` and the network quiet. */
    async open(address) {
      await own.goto(origin + address, { waitUntil: 'commit' })
      const shown = await h.until(
        () => own.evaluate(() => (document.querySelector('main')?.innerText.trim().length ?? 0) > 0),
        20000,
      )
      const quiet = await h.quiet()
      return shown && quiet
    },
    /** The server calls made during `ms` of doing nothing: the App's own, and the host's. */
    async idle(ms = 5000) {
      const start = Date.now()
      await sleep(ms)
      const made = calls.filter((call) => call.at >= start)
      return {
        app: made.filter((call) => call.kind === 'app').map((call) => call.name),
        host: made.filter((call) => call.kind === 'host').map((call) => call.name),
      }
    },
    /** `a, a, b` as `a ×2, b`. */
    tally(names) {
      const counts = new Map()
      for (const name of names) {
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
      return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ')
    },
    /** The addresses the page shows over `ms`, one entry per change. */
    async trail(ms = 2500) {
      const seen = []
      const end = Date.now() + ms
      while (Date.now() < end) {
        const current = h.path()
        if (seen[seen.length - 1] !== current) {
          seen.push(current)
        }
        await sleep(100)
      }
      return seen
    },
    /** Records one assertion. A failed one takes a screenshot unless `shots` is off. */
    async check(name, pass, detail) {
      const row = { name, pass: Boolean(pass), detail: String(detail ?? '') }
      if (!row.pass) {
        row.step = step
        if (args.shots !== false) {
          row.shot = await own
            .screenshot({ type: 'jpeg', quality: 60 })
            .then((image) => image.toString('base64'))
            .catch(() => undefined)
        }
      }
      rows.push(row)
      return row.pass
    },
    /** Records something worth seeing that passes or fails nothing. */
    note(name, detail) {
      rows.push({ name, pass: true, info: true, detail: String(detail ?? '') })
    },
    async close() {
      await ctx.close().catch(() => {})
    },
  }
  return h
}
