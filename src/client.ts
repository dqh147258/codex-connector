import { Agent, request } from 'node:http';
/** A dedicated direct-loopback agent. Never use global fetch/globalAgent, which
 * newer Node versions can configure to send local bearer tokens via env proxies.
 * proxyEnv:{} explicitly disables the optional Node 24+ proxy support; older
 * supported Node versions ignore this unknown option. No redirects are followed.
 */
const directAgent = new Agent({ keepAlive: false, ...{ proxyEnv: {} } });
export async function commandRequest(port: number, token: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request({ hostname: '127.0.0.1', port, path: '/v1/command', method: 'POST', agent: directAgent,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, signal: AbortSignal.timeout(30000) }, res => {
      const buffers: Buffer[] = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { res.destroy(Error('Response exceeds 2 MiB')); return; } buffers.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(buffers).toString('utf8'));
          if (res.statusCode !== 200) reject(Error('Command rejected. Check local status and configuration.'));
          else resolve(value);
        } catch { reject(Error('Invalid connector response')); }
      });
    });
    req.on('error', () => reject(Error('Cannot reach the local connector. Verify daemon, port and sandbox access.')));
    req.end(body);
  });
}
