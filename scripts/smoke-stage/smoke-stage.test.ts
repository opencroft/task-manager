import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkCode, report, type SmokeConfig, smokeChecks } from './checks.ts'
import { authorizationHeader, McpSession, runCodeValue, sseEvents } from './mcp.ts'

const here = dirname(fileURLToPath(import.meta.url))
const source = (file: string) => readFileSync(join(here, 'browser', file), 'utf8')

const CONFIG: SmokeConfig = {
  origin: 'https://tasks.example.com',
  space: 'space-1',
  extension: 'my-org.task-manager',
  apps: ['app-a', 'app-b'],
  pages: ['my-work', 'tasks', 'board', 'timeline', 'workflows', 'task'],
  backScroll: [
    { app: 'app-a', top: 300, via: 'task' },
    { app: 'app-b', top: 3000, via: 'board' },
  ],
  leave: { app: 'app-a', switchTo: 'app-b', otherApp: 'other-app' },
  phone: { app: 'app-a', width: 390, height: 800, pages: ['board', 'timeline', 'workflows', 'my-work', 'tasks'] },
}

describe('authorizationHeader', () => {
  it('takes a whole header value, user:password, or its base64', () => {
    assert.equal(authorizationHeader('Basic abc='), 'Basic abc=')
    assert.equal(authorizationHeader('user:password'), `Basic ${Buffer.from('user:password').toString('base64')}`)
    assert.equal(authorizationHeader(' dXNlcjpwYXNzd29yZA== \n'), 'Basic dXNlcjpwYXNzd29yZA==')
  })
})

describe('sseEvents', () => {
  it('returns complete events and keeps the unfinished rest', () => {
    const { data, rest } = sseEvents('event: message\r\ndata: {"a":1}\r\n\r\ndata: {"b"')
    assert.deepEqual(data, ['{"a":1}'])
    assert.equal(rest, 'data: {"b"')
  })

  it('joins multi-line data and skips events without data', () => {
    assert.deepEqual(sseEvents(': keep-alive\n\ndata: [1,\ndata: 2]\n\n').data, ['[1,\n2]'])
  })
})

describe('runCodeValue', () => {
  it('reads the Result section as JSON', () => {
    const text = '### Result\n{"rows":[]}\n### Ran Playwright code\n```js\n…\n```'
    assert.deepEqual(runCodeValue({ content: [{ type: 'text', text }] }), { rows: [] })
  })

  it('throws the Error section', () => {
    assert.throws(
      () => runCodeValue({ content: [{ type: 'text', text: '### Error\nTimeout 5000ms exceeded' }] }),
      /Timeout 5000ms/,
    )
  })
})

describe('smokeChecks', () => {
  it('covers every page of both Apps, the two Back-scroll paths, leaving, and the phone', () => {
    const ids = smokeChecks(CONFIG).map((check) => check.id)
    assert.equal(ids.filter((id) => id.startsWith('load ')).length, 12)
    assert.ok(ids.includes('back-scroll app-a 300 via task'))
    assert.ok(ids.includes('back-scroll app-b 3000 via board'))
    assert.deepEqual(
      ids.filter((id) => id.startsWith('leave ')),
      ['leave app-a via switcher', 'leave app-a via graph', 'leave app-a via back'],
    )
    assert.ok(ids.includes('phone app-a 390'))
  })

  it('builds, for each check, one function the browser can parse', () => {
    for (const check of smokeChecks(CONFIG)) {
      const code = checkCode(
        check,
        { helpers: source('helpers.js'), check: source(check.file) },
        { config: CONFIG, shots: true },
      )
      assert.equal(typeof new Function(`return (${code})`)(), 'function', check.id)
    }
  })

  it('refuses a browser file that does not default-export its function', () => {
    const [check] = smokeChecks(CONFIG)
    assert.throws(
      () =>
        checkCode(
          check,
          { helpers: source('helpers.js'), check: 'async (page) => {}' },
          { config: CONFIG, shots: false },
        ),
      /must `export default` its function/,
    )
  })
})

describe('browser sources', () => {
  it('use no global the browser_run_code_unsafe sandbox lacks', () => {
    // browser_run_code_unsafe has no Buffer, atob, TextDecoder, URL or timers,
    // and a ReferenceError thrown in an event handler ends the whole call.
    for (const file of ['helpers.js', 'page-load.js', 'back-scroll.js', 'leave.js', 'phone.js']) {
      const code = source(file)
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
      assert.doesNotMatch(
        code,
        /\bBuffer\.|\batob\(|\bbtoa\(|\bTextDecoder\b|\bsetTimeout\(|\bsetInterval\(|\bnew URL\(/,
        file,
      )
    }
  })
})

describe('report', () => {
  it('tables every assertion and lists each failure with its step and screenshot', () => {
    const { table, passed } = report([
      {
        check: 'load app-a/tasks',
        rows: [
          { name: '0 App calls in 5 s idle', pass: true, detail: '0 (4 on load)' },
          { name: 'host calls in 5 s idle', pass: true, info: true, detail: 'listSessionActivity ×2' },
        ],
      },
      {
        check: 'back-scroll app-a 300 via task',
        rows: [{ name: 'Back gives 300', pass: false, detail: '/tasks at 0', step: 'Back to the list' }],
        shots: { 0: 'smoke-results/x/back-0.jpg' },
      },
    ])
    assert.equal(passed, false)
    assert.match(table, /\| load app-a\/tasks \| 0 App calls in 5 s idle \| pass \| 0 \(4 on load\) \|/)
    assert.match(table, /\| load app-a\/tasks \| host calls in 5 s idle \| info \| listSessionActivity ×2 \|/)
    assert.match(table, /\| back-scroll app-a 300 via task \| Back gives 300 \| \*\*FAIL\*\* \| \/tasks at 0 \|/)
    assert.match(
      table,
      /1 of 2 assertions failed:\n- back-scroll app-a 300 via task, "Back gives 300": at step "Back to the list", screenshot smoke-results\/x\/back-0.jpg/,
    )
  })
})

describe('McpSession', () => {
  it('holds one session, answers the server ping mid-call, and returns the tool result', async () => {
    const seen: { method?: string; session?: string; id?: unknown; result?: unknown; auth?: string }[] = []
    let pong: () => void = () => {}
    const ponged = new Promise<void>((resolve) => {
      pong = resolve
    })
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      let body = ''
      for await (const chunk of request) {
        body += chunk
      }
      if (request.method === 'DELETE') {
        seen.push({ method: 'DELETE', session: request.headers['mcp-session-id'] as string })
        response.end()
        return
      }
      const message = JSON.parse(body)
      seen.push({
        method: message.method,
        session: request.headers['mcp-session-id'] as string | undefined,
        id: message.id,
        result: message.result,
        auth: request.headers.authorization,
      })
      if (message.method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's-1' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26' } }))
      } else if (message.method === 'tools/call') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('event: message\ndata: {"jsonrpc":"2.0","id":0,"method":"ping"}\n\n')
        await ponged
        const text = '### Result\n{"rows":[{"name":"ok","pass":true,"detail":""}]}'
        response.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } })}\n\n`,
        )
      } else {
        if (message.id === 0 && message.result) {
          pong()
        }
        response.writeHead(202)
        response.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
      const session = new McpSession(url, authorizationHeader('user:password'))
      await session.open()
      const value = runCodeValue(await session.callTool('browser_run_code_unsafe', { code: 'x' }, 5000))
      await session.close()
      assert.deepEqual(value, { rows: [{ name: 'ok', pass: true, detail: '' }] })
      assert.deepEqual(
        seen.map((entry) => [entry.method ?? `answer ${entry.id}`, entry.session ?? null]),
        [
          ['initialize', null],
          ['notifications/initialized', 's-1'],
          ['tools/call', 's-1'],
          ['answer 0', 's-1'],
          ['DELETE', 's-1'],
        ],
      )
      assert.deepEqual(seen[3].result, {})
      assert.equal(seen[0].auth, authorizationHeader('user:password'))
    } finally {
      server.close()
    }
  })
})
