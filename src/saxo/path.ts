/**
 * Guard for caller-supplied values that are interpolated into Saxo URL
 * paths. `encodeURIComponent` alone still lets through `.` / `..` (which
 * URL normalisation resolves as path traversal) and leaves already-encoded
 * sequences such as `%2e` / `%2f` to be decoded by intermediaries, so we
 * reject those shapes outright before encoding.
 */
export class UnsafePathSegmentError extends Error {
  constructor(name: string) {
    super(`Invalid ${name}: value is not allowed in a URL path segment.`);
    this.name = 'UnsafePathSegmentError';
  }
}

const FORBIDDEN_CHARS = /[/\\?#]/;
const FORBIDDEN_ENCODED = /%(?:2e|2f|5c)/i;

export function assertSafePathSegment(value: unknown, name = 'path parameter'): string {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string') {
    throw new UnsafePathSegmentError(name);
  }
  if (
    text === '' ||
    text === '.' ||
    text === '..' ||
    FORBIDDEN_CHARS.test(text) ||
    FORBIDDEN_ENCODED.test(text)
  ) {
    throw new UnsafePathSegmentError(name);
  }
  return text;
}

/** Validate then percent-encode a single URL path segment. */
export function pathSegment(value: unknown, name?: string): string {
  return encodeURIComponent(assertSafePathSegment(value, name));
}
