// The type an attachment is stored and handed out with, decided here and never
// taken from the uploader. Only raster images recognised by their own bytes
// may be shown inline; everything else is a download, and anything not on the
// short list below is plain bytes. No type that a browser would run or render
// as a page (HTML, SVG, XML, scripts) is ever produced.

/** Raster formats a browser shows as a picture and nothing more, by their leading bytes. */
const RASTER_SIGNATURES: Array<{ type: string; matches: (bytes: Uint8Array) => boolean }> = [
  { type: 'image/png', matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { type: 'image/jpeg', matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { type: 'image/gif', matches: (b) => ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a' },
  { type: 'image/webp', matches: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
]

/** Download-only types worth naming, by extension. Anything else is `application/octet-stream`. */
const DOWNLOAD_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, i) => bytes[i] === value)
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to))
}

export function decideType(bytes: Uint8Array, name: string): { contentType: string; previewable: boolean } {
  const raster = RASTER_SIGNATURES.find((signature) => signature.matches(bytes))
  if (raster) {
    return { contentType: raster.type, previewable: true }
  }
  const extension = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
  return { contentType: DOWNLOAD_TYPES[extension] ?? 'application/octet-stream', previewable: false }
}
