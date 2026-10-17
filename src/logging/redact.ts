/**
 * Two-layer redaction applied to everything the logger writes.
 * See docs/08-error-handling.md §8.7.
 */

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'card',
  'cvc',
  'secret',
  'secrethash',
  'secretencrypted',
  'numberencrypted',
  'apikeys',
  'key',
]);

const MAX_STRING = 2000;
const MAX_DEPTH = 6;

// Boundaries exclude [A-Za-z0-9_] so digit runs inside IDs (e.g. hex request IDs) are left alone.
const PAN_CANDIDATE = /(?<![A-Za-z0-9_])\d(?:[ -]?\d){11,18}(?![A-Za-z0-9_])/g;

const PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  [/\b(sk|pk)_test_[0-9a-f]{16}_[A-Za-z0-9_-]{43}/g, (_m, type) => `${type}_test_[REDACTED]`],
  [/whsec_[A-Za-z0-9_-]{43}/g, 'whsec_[REDACTED]'],
  [/Bearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]'],
  [/\bv\d+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*/g, '[REDACTED_CIPHERTEXT]'],
];

export function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function redactString(input: string): string {
  let out = input;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement as never);
  }
  out = out.replace(PAN_CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, '');
    return digits.length >= 12 && digits.length <= 19 && passesLuhn(digits) ? '[REDACTED_PAN]' : match;
  });
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[truncated]` : out;
}

export function serializeError(err: Error, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = { name: err.name, message: err.message, stack: err.stack };
  const code = (err as { code?: unknown }).code;
  if (code !== undefined) out.code = code;
  if (err.cause !== undefined && depth < 3) {
    out.cause = err.cause instanceof Error ? serializeError(err.cause, depth + 1) : err.cause;
  }
  return out;
}

export function redact(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return redactString(v);
    if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? v.toString() : v;
    if (Buffer.isBuffer(v)) return '[Buffer]';
    if (seen.has(v)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[Truncated]';
    seen.add(v);

    if (v instanceof Error) return walk(serializeError(v), depth);
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));

    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : walk(val, depth + 1);
    }
    return out;
  };

  return walk(value, 0);
}
