import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Connector } from './connector.js';
async function jsonBody(req: IncomingMessage): Promise<any> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Error('Content-Type must be application/json');
  let body = ''; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length; if (bytes > 65536) throw Error('Request exceeds 64 KiB'); body += chunk.toString('utf8');
  }
  return JSON.parse(body || '{}');
}
export function apiServer(connector: Connector, token: string) {
  return createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    const supplied = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
    if (req.headers.origin || !/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '') || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
    }
    try {
      if (req.method !== 'POST' || req.url !== '/v1/command') { res.writeHead(404); res.end('{"error":"Not found"}'); return; }
      const body = await jsonBody(req); let result: unknown;
      switch (body.command) {
        case 'create': result = await connector.create(body); break;
        case 'send': result = await connector.send(body.session, body.text); break;
        case 'ask': result = connector.enqueue(body.session, body.text); break;
        case 'read': result = connector.read(body.session); break;
        case 'ack': result = connector.ack(body.session, body.jobIds); break;
        case 'status': result = connector.status(body.session); break;
        case 'resolve': result = connector.resolve(body.session, body.jobId); break;
        default: throw Error('Unknown command');
      }
      res.end(JSON.stringify({ ok: true, result }));
      if (['ask', 'resolve'].includes(body.command)) connector.pump(body.session);
    } catch (error) {
      // Never expose raw downstream exception text, credential-bearing objects, or stack traces.
      res.writeHead(400); res.end(JSON.stringify({ error: 'Command rejected. Check session, project, channel, text limits, and local status.' }));
    }
  });
}
