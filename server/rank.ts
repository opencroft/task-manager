// Fractional order keys: a string strictly between any two others can always
// be generated, so inserting or moving a task rewrites one row, never its
// neighbours. Keys are base-62 digit strings compared as plain strings
// (SQLite's default BINARY collation agrees with JS `<`), never ending in the
// zero digit, which is what keeps a midpoint always available.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Shared prefix: recurse on what follows it.
    let n = 0
    while ((a[n] ?? '0') === b[n]) {
      n++
    }
    if (n > 0) {
      return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
    }
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length
  if (digitB - digitA > 1) {
    return DIGITS[Math.round((digitA + digitB) / 2)]
  }
  // Adjacent first digits.
  if (b !== null && b.length > 1) {
    return b.slice(0, 1)
  }
  return DIGITS[digitA] + midpoint(a.slice(1), null)
}

function assertKey(key: string): void {
  if (!key || key.endsWith('0') || [...key].some((ch) => !DIGITS.includes(ch))) {
    throw new Error(`Invalid rank key: ${JSON.stringify(key)}`)
  }
}

/** A key strictly between `lower` and `upper`; null means unbounded on that side. */
export function rankBetween(lower: string | null, upper: string | null): string {
  if (lower !== null) {
    assertKey(lower)
  }
  if (upper !== null) {
    assertKey(upper)
  }
  if (lower !== null && upper !== null && lower >= upper) {
    throw new Error(`rankBetween: ${lower} is not below ${upper}`)
  }
  return midpoint(lower ?? '', upper)
}

function encode(value: number, width: number): string {
  let out = ''
  for (let i = 0; i < width; i++) {
    out = DIGITS[value % 62] + out
    value = Math.floor(value / 62)
  }
  return out
}

/**
 * `count` keys spread evenly over a fixed width, in ascending order — what a
 * list is renumbered to when repeated inserts at one spot have made its keys
 * long. The width leaves at least 62 values between neighbours, so every
 * later insert has room before a key grows again.
 */
export function evenRanks(count: number): string[] {
  const width = Math.max(2, Math.ceil(Math.log(count + 2) / Math.log(62)) + 1)
  const space = 62 ** width
  const keys: string[] = []
  for (let i = 1; i <= count; i++) {
    let value = Math.floor((i * space) / (count + 1))
    let key = encode(value, width)
    while (key.endsWith('0')) {
      value += 1
      key = encode(value, width)
    }
    keys.push(key)
  }
  return keys
}
