import { Agent, request } from 'node:http';
/** A dedicated direct-loopback agent. Never use global fetch/globalAgent, which
 * newer Node versions can configure to send local bearer tokens via env proxies.
 * proxyEnv:{} explicitly disables the optional Node 24+ proxy support; older
 * supported Node versions ignore this unknown option. No redirects are followed.
 */
const directAgent = new Agent({ keepAlive: false, ...{ proxyEnv: {} } });
export async function commandRequest(port: number, token: string, payload: unknown, timeoutMs = 30000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request({ hostname: '127.0.0.1', port, path: '/v1/command', method: 'POST', agent: directAgent,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, signal: AbortSignal.timeout(timeoutMs) }, res => {
      const buffers: Buffer[] = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { res.destroy(Error('Response exceeds 2 MiB')); return; } buffers.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(buffers).toString('utf8'));
          if (res.statusCode !== 200) {
            const publicCodes=new Set(['LOCAL_SCOPE_DENIED','SERVER_UNAVAILABLE','RECEIPT_NOT_FOUND','REQUEST_ID_CONFLICT','LOCAL_BINDING_REQUIRED','SERVER_SELECTION_REQUIRED','SERVER_NOT_FOUND','INVALID_CURSOR','INVALID_EVENT_CURSOR','INVALID_LOCAL_EVENT_CURSOR','LOCAL_EVENT_SUBSCRIPTION_UNAVAILABLE','LOCAL_EVENT_STREAM_LIMIT','LOCAL_ACTION_REQUIRED','SLACK_EXPLICIT_BINDING_UNAVAILABLE','SESSION_NOT_FOUND','ACTOR_REVOKED','LOCAL_DISABLED']);
            const code=publicCodes.has(value?.error)?value.error:res.statusCode===401?'UNAUTHORIZED':res.statusCode===403?'FORBIDDEN':'REQUEST_REJECTED';
            reject(Error('Local connector: '+code));
          }
          else resolve(value);
        } catch { reject(Error('Invalid connector response')); }
      });
    });
    req.on('error', e => reject(Error((e as NodeJS.ErrnoException).code==='ABORT_ERR'?
      'Local connector timed out; an in-flight command may already have been admitted. Retain the original request ID and server.':
      'Cannot reach the local connector. Verify daemon, port and sandbox access.')));
    req.end(body);
  });
}
