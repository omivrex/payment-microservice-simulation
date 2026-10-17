import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { createLogger } from '../../src/logging/logger.ts';

function capture() {
  const calls: Array<{ method: string; line: string }> = [];
  for (const method of ['log', 'warn', 'error'] as const) {
    mock.method(console, method, (line: string) => calls.push({ method, line }));
  }
  return calls;
}

describe('§8.6 logger', () => {
  it('routes each level to its documented console method', (t) => {
    const calls = capture();
    const log = createLogger({ level: 'debug' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    log.fatal('f');
    mock.restoreAll();
    assert.deepEqual(
      calls.map((c) => c.method),
      ['log', 'log', 'warn', 'error', 'error'],
    );
  });

  it('respects LOG_LEVEL', () => {
    const calls = capture();
    const log = createLogger({ level: 'warn' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    mock.restoreAll();
    assert.equal(calls.length, 1);
  });

  it('writes one line of valid JSON even when the message has newlines', () => {
    const calls = capture();
    createLogger().info('line1\nline2', { nested: { a: 'x\ny' } });
    mock.restoreAll();
    assert.equal(calls.length, 1);
    assert.ok(!calls[0]!.line.includes('\n'));
    const entry = JSON.parse(calls[0]!.line);
    assert.equal(entry.msg, 'line1\nline2');
    assert.equal(entry.level, 'info');
    assert.ok(entry.time);
  });

  it('child loggers carry their context and redact it', () => {
    const calls = capture();
    createLogger().child({ requestId: 'req_1', authorization: 'Bearer abc' }).info('hi', { cvc: '123' });
    mock.restoreAll();
    const entry = JSON.parse(calls[0]!.line);
    assert.equal(entry.requestId, 'req_1');
    assert.equal(entry.authorization, '[REDACTED]');
    assert.equal(entry.cvc, '[REDACTED]');
  });
});
