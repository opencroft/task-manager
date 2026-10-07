// What `npm run smoke:stage` checks, and how a check becomes the one function
// the browser runs. The checks themselves are the files in `browser/`, sent as
// source text (see browser/helpers.js for why).

export interface SmokeConfig {
  /** The instance under test. */
  origin: string
  /** The space holding the Apps below. */
  space: string
  /** The extension whose HTTP routes (`/api/ext/<extension>/…`) count as the App's own calls. */
  extension: string
  /** Task-manager Apps whose pages are loaded and watched while idle. */
  apps: string[]
  /** Their pages, plus `task` for a task's own page. */
  pages: string[]
  /** Back restores the list: `task` opens a visible task, `board` takes the sidebar's Board link. */
  backScroll: { app: string; top: number; via: 'task' | 'board' }[]
  /** Leaving `app` through the title bar's switcher (to `switchTo`), the graph link, and Back/Forward via `otherApp`. */
  leave: { app: string; switchTo: string; otherApp: string }
  /** The phone sheet and page widths, on `app` at `width` px. */
  phone: { app: string; width: number; height: number; pages: string[] }
}

export interface SmokeCheck {
  id: string
  /** The file under browser/ that runs it. */
  file: 'page-load.js' | 'back-scroll.js' | 'leave.js' | 'phone.js'
  args: Record<string, unknown>
}

export function smokeChecks(config: SmokeConfig): SmokeCheck[] {
  const checks: SmokeCheck[] = []
  for (const app of config.apps) {
    for (const page of config.pages) {
      checks.push({ id: `load ${app}/${page}`, file: 'page-load.js', args: { app, page } })
    }
  }
  for (const scroll of config.backScroll) {
    checks.push({ id: `back-scroll ${scroll.app} ${scroll.top} via ${scroll.via}`, file: 'back-scroll.js', args: { ...scroll } })
  }
  // One check per way out: a browser server may close a call's contexts after
  // a time limit, so each check stays short.
  for (const way of ['switcher', 'graph', 'back']) {
    checks.push({ id: `leave ${config.leave.app} via ${way}`, file: 'leave.js', args: { ...config.leave, way } })
  }
  const { width, height, ...phone } = config.phone
  checks.push({
    id: `phone ${phone.app} ${width}`,
    file: 'phone.js',
    args: { ...phone, viewport: { width, height } },
  })
  return checks
}

/**
 * The function `browser_run_code_unsafe` runs for one check: set up the
 * check's own context (helpers), run it, and always close the context. It
 * returns the check's rows; a check that throws gets a failed row saying where.
 */
export function checkCode(
  check: SmokeCheck,
  sources: { helpers: string; check: string },
  options: { config: SmokeConfig; shots: boolean },
): string {
  const { origin, space, extension } = options.config
  const args = { ...check.args, origin, space, extension, shots: options.shots }
  return `async (page) => {
  const args = ${JSON.stringify(args)}
  const h = await (
${sources.helpers.trim()}
  )(page, args)
  try {
    await (
${sources.check.trim()}
    )(page, args, h)
  } catch (error) {
    await h.check('runs to the end', false, String(error).slice(0, 300))
  } finally {
    await h.close()
  }
  return { rows: h.rows }
}`
}

export interface SmokeRow {
  name: string
  pass: boolean
  detail: string
  /** An informational line (the host's idle calls): shown, never failed, not counted. */
  info?: boolean
  step?: string
  shot?: string
}

export interface SmokeResult {
  check: string
  rows: SmokeRow[]
  /** Where each failed row's screenshot was saved, by row index. */
  shots?: Record<number, string>
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** The pass/fail table, then each failure's step and screenshot. */
export function report(results: SmokeResult[]): { table: string; passed: boolean } {
  const lines = ['| Check | Assertion | Result | Detail |', '| --- | --- | --- | --- |']
  const failures: string[] = []
  for (const result of results) {
    result.rows.forEach((row, index) => {
      const verdict = row.info ? 'info' : row.pass ? 'pass' : '**FAIL**'
      lines.push(`| ${cell(result.check)} | ${cell(row.name)} | ${verdict} | ${cell(row.detail)} |`)
      if (!row.pass) {
        const shot = result.shots?.[index]
        failures.push(
          `- ${result.check}, "${row.name}": at step "${row.step ?? '?'}"${shot ? `, screenshot ${shot}` : ''}`,
        )
      }
    })
  }
  const total = results.reduce((sum, result) => sum + result.rows.filter((row) => !row.info).length, 0)
  const failed = failures.length
  lines.push('', failed === 0 ? `All ${total} assertions passed.` : `${failed} of ${total} assertions failed:`, ...failures)
  return { table: lines.join('\n'), passed: failed === 0 }
}
