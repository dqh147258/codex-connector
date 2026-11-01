import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './types.js';
export const home = () => process.env.CONNECTOR_HOME || join(homedir(), '.codex-connector');
export function parseConfig(raw: unknown): Config {
  const c = raw as Config;
  if (!c || !/^T[A-Z0-9]+$/.test(c.teamId)) throw Error('Set a valid teamId (T…) in config.json');
  for (const key of ['allowedUsers', 'allowedChannels'] as const) {
    if (!Array.isArray(c[key]) || !c[key].length || c[key].some(x => typeof x !== 'string' || !/^[A-Z][A-Z0-9]+$/.test(x)))
      throw Error(`${key} must contain explicit Slack IDs; empty/wildcard access is forbidden`);
  }
  if (!c.projects || !Object.keys(c.projects).length) throw Error('Configure at least one project alias');
  for (const [alias, dir] of Object.entries(c.projects)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(alias) || typeof dir !== 'string' || !isAbsolute(dir)) throw Error('Projects require simple aliases and absolute paths');
    c.projects[alias] = realpathSync(dir);
  }
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) throw Error('Invalid port');
  if (typeof c.codexExecutable !== 'string' || !isAbsolute(c.codexExecutable)) throw Error('codexExecutable must be an explicit absolute executable path (no shell command)');
  if (!['read-only', 'workspace-write', 'inherit'].includes(c.sandbox)) throw Error('sandbox must be read-only, workspace-write, or explicitly inherit');
  return c;
}
export function loadConfig(dir = home()): Config { return parseConfig(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))); }
export function readToken(dir = home()): string {
  const token = (process.env.CONNECTOR_TOKEN || readFileSync(join(dir, 'api.token'), 'utf8')).trim();
  if (token.length < 32) throw Error('Local API token must have at least 32 characters');
  return token;
}
