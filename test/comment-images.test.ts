import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { attachmentImageMarkdown, commentParts } from '../src/attachments/comment-images'

const A = '0b7c2d1e-4f5a-4b6c-8d9e-0f1a2b3c4d5e'
const B = '1c8d3e2f-5a6b-4c7d-9e0f-1a2b3c4d5e6f'

describe('commentParts', () => {
  it('splits text around each attachment image, in order', () => {
    assert.deepEqual(commentParts(`Before\n${attachmentImageMarkdown(A, 'image.png')}\nbetween ![b](attachment:${B}) after`), [
      { kind: 'text', text: 'Before\n' },
      { kind: 'image', id: A, name: 'image.png' },
      { kind: 'text', text: '\nbetween ' },
      { kind: 'image', id: B, name: 'b' },
      { kind: 'text', text: ' after' },
    ])
  })

  it('leaves a body without references, and ordinary images, as one text part', () => {
    const body = 'See ![logo](https://example.com/logo.png) and **bold**'
    assert.deepEqual(commentParts(body), [{ kind: 'text', text: body }])
  })

  it('keeps a reference inside a fenced code block as text, and the block whole', () => {
    const body = `Example:\n\`\`\`md\n![x](attachment:${A})\n\`\`\`\n![y](attachment:${B})`
    assert.deepEqual(commentParts(body), [
      { kind: 'text', text: `Example:\n\`\`\`md\n![x](attachment:${A})\n\`\`\`\n` },
      { kind: 'image', id: B, name: 'y' },
    ])
  })

  it('drops empty text between images, and an unclosed fence keeps the rest as text', () => {
    assert.deepEqual(commentParts(`![a](attachment:${A})\n![b](attachment:${B})`), [
      { kind: 'image', id: A, name: 'a' },
      { kind: 'image', id: B, name: 'b' },
    ])
    assert.deepEqual(commentParts(`\`\`\`\n![a](attachment:${A})`), [{ kind: 'text', text: `\n\`\`\`\n![a](attachment:${A})` }])
  })

  it('makes a name safe to sit inside the brackets', () => {
    assert.equal(attachmentImageMarkdown(A, 'a [b]\nc.png'), `![a  b  c.png](attachment:${A})`)
  })
})
