// A minimal MCP client over Streamable HTTP, enough to call a remote Playwright
// MCP server's tools from a shell. It holds one session for the whole run and
// answers the server's `ping` requests: a client that ignores them gets a
// zero-byte answer to its first tool call and "Session not found" after that.

export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

interface ToolResult {
  content?: { type: string; text?: string }[]
  isError?: boolean
}

/**
 * The `Authorization` header for the browser server's credential: a whole
 * header value (`Basic …`), `user:password`, or the base64 of `user:password`.
 */
export function authorizationHeader(secret: string): string {
  const value = secret.trim()
  if (/^(basic|bearer) /i.test(value)) {
    return value
  }
  return `Basic ${value.includes(':') ? Buffer.from(value).toString('base64') : value}`
}

/** Splits a server-sent-events buffer into the data of each complete event, and the unfinished rest. */
export function sseEvents(buffer: string): { data: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const blocks = normalized.split('\n\n')
  const rest = blocks.pop() ?? ''
  const data = blocks
    .map((block) =>
      block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n'),
    )
    .filter((text) => text.length > 0)
  return { data, rest }
}

/**
 * What `browser_run_code_unsafe` returned. The Playwright MCP answers in
 * markdown sections: `### Result` holds the function's value as JSON, and
 * `### Error` a thrown error.
 */
export function runCodeValue(result: ToolResult): unknown {
  const text = (result.content ?? []).map((part) => part.text ?? '').join('\n')
  const error = text.match(/### Error\n([\s\S]*?)(?:\n### |$)/)
  if (result.isError || error) {
    throw new Error((error?.[1] ?? text).trim().slice(0, 500))
  }
  const value = text.match(/### Result\n([\s\S]*?)(?:\n### |$)/)
  if (!value) {
    throw new Error(`no result in the answer: ${text.slice(0, 200)}`)
  }
  return JSON.parse(value[1])
}

export class McpSession {
  private readonly url: string
  private readonly authorization: string
  private sessionId: string | null = null
  private nextId = 1

  constructor(url: string, authorization: string) {
    this.url = url
    this.authorization = authorization
  }

  async open(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'task-pipelines-smoke-stage', version: '1' },
    })
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolResult> {
    return (await this.request('tools/call', { name, arguments: args }, timeoutMs)) as ToolResult
  }

  async close(): Promise<void> {
    if (this.sessionId) {
      await fetch(this.url, { method: 'DELETE', headers: this.headers() }).catch(() => {})
      this.sessionId = null
    }
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: this.authorization,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    }
  }

  private async post(message: JsonRpcMessage, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(message),
      signal,
    })
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`${message.method}: HTTP ${response.status} ${body.slice(0, 200)}`)
    }
    return response
  }

  private async request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++
    const signal = AbortSignal.timeout(timeoutMs)
    const response = await this.post({ jsonrpc: '2.0', id, method, params }, signal)
    const answer = (message: JsonRpcMessage) => {
      if (message.error) {
        throw new Error(`${method}: ${message.error.message}`)
      }
      return message.result
    }
    if ((response.headers.get('content-type') ?? '').includes('application/json')) {
      return answer((await response.json()) as JsonRpcMessage)
    }
    if (!response.body) {
      throw new Error(`${method}: empty answer`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const { data, rest } = sseEvents(buffer)
      buffer = rest
      for (const text of data) {
        const message = JSON.parse(text) as JsonRpcMessage
        if (message.method === 'ping' && message.id !== undefined) {
          await this.post({ jsonrpc: '2.0', id: message.id, result: {} })
        } else if (message.id === id) {
          await reader.cancel().catch(() => {})
          return answer(message)
        }
      }
    }
    throw new Error(`${method}: the answer ended without a result`)
  }
}
