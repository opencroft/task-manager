// npm run smoke:stage — the task manager's smoke check against a deployed
// instance. Drives a remote Playwright MCP browser, one isolated context per
// check, and prints a pass/fail table. It creates no data.
//
//   npm run smoke:stage                     every check
//   npm run smoke:stage -- --only back      checks whose id contains "back"
//   npm run smoke:stage -- --list           the check ids
//   npm run smoke:stage -- --print <id>     one check's browser function, for
//                                           running it through another client
//   --no-shots                              no screenshots on failure
//
// Needs SMOKE_CONFIG (a JSON file holding a SmokeConfig: the instance, its
// space and the Apps to check), QA_BROWSER_URL (the browser's MCP endpoint)
// and QA_BROWSER_AUTH (its credential). SMOKE_ORIGIN overrides the config's
// origin.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type SmokeConfig, type SmokeResult, type SmokeRow, checkCode, report, smokeChecks } from './smoke-stage/checks.ts'
import { McpSession, authorizationHeader, runCodeValue } from './smoke-stage/mcp.ts'

const here = dirname(fileURLToPath(import.meta.url))
const CHECK_TIMEOUT_MS = 120_000

const argv = process.argv.slice(2)
const option = (name: string) => {
  const at = argv.indexOf(name)
  return at >= 0 ? (argv[at + 1] ?? '') : null
}
const required = (name: string, what: string): string => {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is not set: ${what}.`)
    process.exit(2)
  }
  return value
}
const configured = JSON.parse(readFileSync(required('SMOKE_CONFIG', 'the path of a JSON file holding the SmokeConfig'), 'utf8')) as SmokeConfig
const config = { ...configured, origin: process.env.SMOKE_ORIGIN ?? configured.origin }
const shots = !argv.includes('--no-shots')
const only = option('--only')
const checks = smokeChecks(config).filter((check) => only === null || check.id.includes(only))
const source = (file: string) => readFileSync(join(here, 'smoke-stage', 'browser', file), 'utf8')
const helpers = source('helpers.js')

if (argv.includes('--list')) {
  for (const check of checks) {
    console.log(check.id)
  }
  process.exit(0)
}

const printed = option('--print')
if (printed !== null) {
  const check = checks.find((candidate) => candidate.id === printed)
  if (!check) {
    console.error(`No check "${printed}". --list shows them.`)
    process.exit(2)
  }
  console.log(checkCode(check, { helpers, check: source(check.file) }, { config, shots }))
  process.exit(0)
}

const QA_BROWSER_URL = required('QA_BROWSER_URL', "the browser's MCP endpoint")
const secret = required('QA_BROWSER_AUTH', "the browser's credential: a whole Authorization value, user:password, or its base64")

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const shotDir = join(here, '..', 'smoke-results', stamp)
let session = new McpSession(QA_BROWSER_URL, authorizationHeader(secret))
await session.open()

const results: SmokeResult[] = []
for (const check of checks) {
  const code = checkCode(check, { helpers, check: source(check.file) }, { config, shots })
  const started = Date.now()
  let rows: SmokeRow[]
  try {
    rows = await run(code)
  } catch (first) {
    // A remote browser may drop a call under load: one retry on a new
    // session, then the check fails with the error.
    try {
      await session.close()
      session = new McpSession(QA_BROWSER_URL, authorizationHeader(secret))
      await session.open()
      rows = await run(code)
    } catch (second) {
      rows = [{ name: 'runs', pass: false, detail: `${String(first).slice(0, 150)}; retry: ${String(second).slice(0, 150)}`, step: 'call the browser' }]
    }
  }
  const saved: Record<number, string> = {}
  rows.forEach((row, index) => {
    if (row.shot) {
      mkdirSync(shotDir, { recursive: true })
      const file = join(shotDir, `${check.id.replace(/[^a-z0-9]+/gi, '-')}-${index}.jpg`)
      writeFileSync(file, Buffer.from(row.shot, 'base64'))
      saved[index] = file
      delete row.shot
    }
  })
  results.push({ check: check.id, rows, shots: saved })
  const failed = rows.filter((row) => !row.pass).length
  console.error(`${failed === 0 ? 'pass' : 'FAIL'}  ${check.id}  (${Math.round((Date.now() - started) / 1000)} s)`)
}
await session.close()

const { table, passed } = report(results)
console.log(table)
process.exit(passed ? 0 : 1)

async function run(code: string): Promise<SmokeRow[]> {
  const value = runCodeValue(await session.callTool('browser_run_code_unsafe', { code }, CHECK_TIMEOUT_MS)) as { rows: SmokeRow[] }
  return value.rows
}
