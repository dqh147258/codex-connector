import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './types.js';
export const home = () => process.env.CONNECTOR_HOME || join(homedir(), '.codex-connector');
function ids(value: unknown, re: RegExp, allowEmpty = false): value is string[] { return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(x => typeof x === 'string' && re.test(x)); }
export function parseConfig(raw: unknown): Config {
  const c = raw as Config;
  if (!c || c.version !== 2) throw Error('Config version 2 required; back up old state/config before migrating.');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(c.instanceId)) throw Error('Invalid instanceId');
  const s = c.slack;
  if (!s || !/^T[A-Z0-9]+$/.test(s.teamId) || !/^[CG][A-Z0-9]+$/.test(s.inputChannel) || !/^[CG][A-Z0-9]+$/.test(s.outputChannel)) throw Error('Explicit workspace/input/output channel IDs required');
  if (!ids(s.allowedHumans, /^U[A-Z0-9]+$/, true) || !ids(s.approvalUsers, /^U[A-Z0-9]+$/) || s.approvalUsers.some(u => !s.allowedHumans.includes(u))) throw Error('approvalUsers must be explicit allowed human user IDs');
  if (!Array.isArray(s.trustedBots) || s.trustedBots.some(b => !/^B[A-Z0-9]+$/.test(b.botId) || !/^U[A-Z0-9]+$/.test(b.userId) || !/^A[A-Z0-9]+$/.test(b.appId))) throw Error('trustedBots need exact botId/userId/appId');
  if (s.trustedBots.some(b => s.approvalUsers.includes(b.userId))) throw Error('A trusted bot cannot be an approval human');
  if (!s.dot || typeof s.dot.name !== 'string' || !s.dot.name.trim() || (s.dot.userId && !/^U[A-Z0-9]+$/.test(s.dot.userId))) throw Error('Set dot name and optional stable userId');
  if(c.screenPolicy !== undefined && (!c.screenPolicy || typeof c.screenPolicy !== 'object' || Array.isArray(c.screenPolicy) || !Object.hasOwn(c.screenPolicy,'enabled') || typeof c.screenPolicy.enabled !== 'boolean' || Object.keys(c.screenPolicy).some(k=>k!=='enabled')))throw Error('Invalid local screenPolicy');
  if(c.filePolicy !== undefined && (!c.filePolicy || typeof c.filePolicy!=='object' || Array.isArray(c.filePolicy) || !Object.hasOwn(c.filePolicy,'allowAbsolutePaths') || typeof c.filePolicy.allowAbsolutePaths!=='boolean' || Object.keys(c.filePolicy).some(k=>k!=='allowAbsolutePaths')))throw Error('Invalid local filePolicy');
  if (!c.projects || typeof c.projects !== 'object' || Array.isArray(c.projects) || (!Object.keys(c.projects).length && c.filePolicy?.allowAbsolutePaths !== true)) throw Error('Configure explicit project aliases unless absolute file access is locally enabled');
  for (const [key, value] of Object.entries(c.projects)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key) || typeof value !== 'string' || !isAbsolute(value)) throw Error('Projects require aliases and absolute directories');
    const real = realpathSync(value);
    if (!statSync(real).isDirectory() || /(^|[\\/])(?:\.codex|\.ssh|\.aws)([\\/]|$)/i.test(real)) throw Error('Project root is restricted');
    c.projects[key] = real;
  }
  if(c.sessionPolicy && (typeof c.sessionPolicy.allowAllSharedSessions!=='boolean'||Object.keys(c.sessionPolicy).some(k=>k!=='allowAllSharedSessions')))throw Error('Invalid local sessionPolicy');
  if (!c.backend || !isAbsolute(c.backend.executable) || /\.(cmd|bat)$/i.test(c.backend.executable)) throw Error('Set native Codex executable or JS launcher absolute path; shell shims forbidden');
  if(c.backend.autoStartDaemon!==undefined&&typeof c.backend.autoStartDaemon!=='boolean')throw Error('autoStartDaemon must be explicit boolean');
  if(c.backend.autoStartDaemon&&c.backend.socketPath)throw Error('autoStartDaemon cannot target an explicit socketPath');
  if (c.backend.socketPath && !isAbsolute(c.backend.socketPath)) throw Error('Explicit socketPath must be absolute');
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) throw Error('Invalid API port');
  if (!Number.isInteger(c.approvalTimeoutSec) || c.approvalTimeoutSec < 30 || c.approvalTimeoutSec > 1800) throw Error('Approval timeout must be 30–1800 seconds');
  return c;
}
export const loadConfig = (dir = home()): Config => parseConfig(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')));
export function readToken(dir = home()): string {
  const token = (process.env.CONNECTOR_TOKEN || readFileSync(join(dir, 'api.token'), 'utf8')).trim();
  if (token.length < 32) throw Error('Local token too short'); return token;
}
