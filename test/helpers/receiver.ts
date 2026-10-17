import { once } from 'node:events';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export type Respond = (req: ReceivedRequest) => { status: number; body?: string; hang?: boolean; streamBytes?: number; location?: string } | Promise<{ status: number }>;

/** Local webhook receiver with scripted responses. */
export async function startReceiver(respond: Respond = () => ({ status: 200 })) {
  const requests: ReceivedRequest[] = [];
  let handler = respond;
  const held: http.ServerResponse[] = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const received = { path: req.url ?? '/', headers: req.headers, body };
      requests.push(received);
      const r = (await handler(received)) as Awaited<ReturnType<Respond>> & { hang?: boolean; streamBytes?: number; body?: string; location?: string };
      if (r.hang) {
        held.push(res);
        return;
      }
      res.statusCode = r.status;
      if (r.location) res.setHeader('location', r.location);
      if (r.streamBytes) {
        const chunk = Buffer.alloc(64 * 1024, 'x');
        let sent = 0;
        const pump = () => {
          while (sent < r.streamBytes!) {
            sent += chunk.length;
            if (!res.write(chunk)) return res.once('drain', pump);
          }
          res.end();
        };
        res.on('error', () => {});
        pump();
        return;
      }
      res.end(r.body ?? 'ok');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  return {
    url: (path = '/hook') => `http://127.0.0.1:${port}${path}`,
    requests,
    setHandler(next: Respond) {
      handler = next;
    },
    /** Releases held ("hang") responses with the given status. */
    releaseHeld(status = 200) {
      for (const res of held.splice(0)) if (!res.writableEnded) res.end(String(status), () => {}).statusCode = status;
    },
    async close() {
      for (const res of held.splice(0)) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
