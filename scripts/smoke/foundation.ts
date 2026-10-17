import { connect } from 'node:net';
import type { SmokeContext } from './harness.ts';

/** Raw HTTP over a socket, for requests fetch refuses to send (malformed on purpose). */
function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('data', (d) => (data += d));
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
    socket.write(payload);
  });
}

export async function foundation(s: SmokeContext): Promise<void> {
  s.section('Foundation: health, docs, error contract');

  const health = await s.call('GET', '/health');
  s.check('GET /health → 200 {status: ok}', health.status === 200 && health.body?.status === 'ok', health.body);
  s.check('X-Request-Id present', /^req_[0-9a-f]{32}$/.test(health.headers.get('x-request-id') ?? ''));

  const spec = await s.call('GET', '/openapi.json');
  s.check('GET /openapi.json → OpenAPI 3.1 document', spec.status === 200 && spec.body?.openapi === '3.1.0');
  const ui = await s.call('GET', '/docs/');
  s.check('GET /docs/ → Swagger UI HTML', ui.status === 200 && /swagger-ui/i.test(ui.text));

  const missing = await s.call('GET', '/does/not/exist');
  s.check('unknown route → JSON 404 not_found with requestId', missing.status === 404 && missing.body?.error?.code === 'not_found' && !!missing.body.error.requestId);
  const wrongMethod = await s.call('DELETE', '/health');
  s.check('wrong method → JSON 404 (not HTML)', wrongMethod.status === 404 && wrongMethod.body?.error?.code === 'not_found');

  s.section('Foundation: trying to break it');

  const badJson = await s.call('POST', '/health', { rawBody: '{"number":"4242424242424242",', headers: { 'content-type': 'application/json' } });
  s.check('malformed JSON → 400 invalid_json', badJson.status === 400 && badJson.body?.error?.code === 'invalid_json');
  s.check('malformed JSON response does not echo the card number', !badJson.text.includes('4242424242424242'));

  const big = await s.call('POST', '/health', { body: { pad: 'x'.repeat(200 * 1024) } });
  s.check('200 kb body → 413 payload_too_large', big.status === 413 && big.body?.error?.code === 'payload_too_large');

  const deep = await s.call('POST', '/health', { rawBody: '['.repeat(5000) + ']'.repeat(5000), headers: { 'content-type': 'application/json' } });
  s.check('deeply nested JSON → handled (4xx), no crash', deep.status >= 400 && deep.status < 500, deep.status);

  const charset = await s.call('POST', '/health', { rawBody: '{}', headers: { 'content-type': 'application/json; charset=utf-7' } });
  s.check('unsupported charset → 4xx JSON error', charset.status >= 400 && charset.status < 500 && !!charset.body?.error, charset.status);

  const proxied = await s.call('GET', '/health', { headers: { 'x-request-id': 'upstream-123' } });
  s.check('valid incoming X-Request-Id is reused', proxied.headers.get('x-request-id') === 'upstream-123');
  const injected = await s.call('GET', '/health', { headers: { 'x-request-id': 'bad id {"level":"fatal"}' } });
  s.check('malicious X-Request-Id is replaced', /^req_/.test(injected.headers.get('x-request-id') ?? ''));

  const garbage = await rawRequest(s.port, 'THIS IS NOT HTTP\r\n\r\n');
  s.check('garbage bytes on the socket → 400 / connection closed, no crash', garbage === '' || /^HTTP\/1\.1 400/.test(garbage), garbage.slice(0, 40));
  const hugeHeader = await rawRequest(s.port, `GET /health HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(20_000)}\r\n\r\n`);
  s.check('20 kb header → 431 / closed, no crash', hugeHeader === '' || /^HTTP\/1\.1 431/.test(hugeHeader), hugeHeader.slice(0, 40));
  const traversal = await s.call('GET', '/..%2f..%2fetc%2fpasswd');
  s.check('path traversal attempt → 404 JSON', traversal.status === 404 && !!traversal.body?.error);

  const burst = await Promise.all(Array.from({ length: 200 }, () => s.call('GET', '/health')));
  s.check('200 concurrent requests → all 200', burst.every((r) => r.status === 200));

  await s.assertAlive('foundation abuse');

  const logLines = s.serverOutput().trim().split('\n');
  s.check('every server log line is valid single-line JSON', logLines.every((l) => {
    try {
      JSON.parse(l);
      return true;
    } catch {
      return false;
    }
  }));
  s.check('access log lines carry requestId and route pattern', /"msg":"request completed","requestId":"req_[0-9a-f]{32}","method":"GET","route":"\/health"/.test(s.serverOutput()));
}
