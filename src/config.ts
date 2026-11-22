import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './types.js';
import { COMMANDS } from './protocol.js';
import { canonicalPath, validServerId, validateIdentities, type BackendProfile } from './servers.js';
export const home = () => process.env.CONNECTOR_HOME || join(homedir(), '.codex-connector');
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && [null,Object.prototype].includes(Object.getPrototypeOf(v));
function keys(v: unknown, allowed: string[]): v is Record<string, unknown> {
  return plain(v) && Object.keys(v).every(k => allowed.includes(k));
}
function ids(value: unknown, re: RegExp, allowEmpty = false): value is string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(x => typeof x === 'string' && re.test(x));
}
function grant(value: unknown, valid: (key: string) => boolean): value is string[] {
  return Array.isArray(value) && value.length <= 128 && new Set(value).size === value.length && value.every(v => typeof v === 'string' && valid(v));
}
function validateProfile(value: unknown): BackendProfile {
  if (!keys(value, ['executable','socketPath','codexHome','expectedVersion','autoStartDaemon','aliases'])) throw Error('Invalid backend profile');
  const p = value as unknown as BackendProfile;
  if (typeof p.executable !== 'string' || !isAbsolute(p.executable) || /[\x00-\x1f\x7f]|\.(cmd|bat)$/i.test(p.executable)) throw Error('Set native Codex executable or JS launcher absolute path; shell shims forbidden');
  if (p.autoStartDaemon !== undefined && typeof p.autoStartDaemon !== 'boolean') throw Error('autoStartDaemon must be explicit boolean');
  if (p.autoStartDaemon && p.socketPath) throw Error('autoStartDaemon cannot target an explicit socketPath');
  for (const value of [p.socketPath,p.codexHome]) {
    if (value !== undefined && (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))) throw Error('Explicit socketPath and codexHome must be absolute paths');
  }
  if (p.expectedVersion !== undefined && (typeof p.expectedVersion !== 'string' || !p.expectedVersion || p.expectedVersion.length > 120 || /[\x00-\x1f\x7f]/.test(p.expectedVersion))) throw Error('Invalid expectedVersion');
  if (p.aliases !== undefined && (!grant(p.aliases,validServerId) || p.aliases.length > 16)) throw Error('Invalid backend aliases');
  return { ...p, ...(p.codexHome ? {codexHome:canonicalPath(p.codexHome)} : {}), ...(p.socketPath ? {socketPath:canonicalPath(p.socketPath)} : {}) };
}
function registry(c: Config): Map<string, BackendProfile> {
  if (c.backends !== undefined && !plain(c.backends)) throw Error('backends must map server IDs to backend profiles');
  const profiles = new Map<string, BackendProfile>();
  for (const [id, profile] of Object.entries(c.backends || {})) profiles.set(id, validateProfile(profile));
  if (c.backend !== undefined) {
    if (profiles.has('default')) throw Error('Configure the default backend only once');
    profiles.set('default', validateProfile(c.backend));
  }
  validateIdentities(profiles);
  if (c.defaultServerId !== undefined && (!validServerId(c.defaultServerId) || !profiles.has(c.defaultServerId))) throw Error('defaultServerId must be a canonical configured server ID');
  const legacy = profiles.get('default');
  if (c.backends !== undefined) {
    c.backends = Object.fromEntries(profiles);
    // Do not serialize .backend as a *second* legacy default on config round-trips.
    // This compatibility view is only for older single-backend consumers. Runtime
    // request routing always uses the registry; no default is inferred for many.
    const selected = (c.defaultServerId ? profiles.get(c.defaultServerId) : legacy) ?? profiles.values().next().value!;
    Object.defineProperty(c, 'backend', {value:selected, enumerable:false,writable:true,configurable:true});
  } else c.backend = legacy!;
  return profiles;
}
function configureSlack(c: Config, profiles: Map<string,BackendProfile>): void {
  const s = c.slack;
  if (s === undefined && c.local?.enabled !== true) throw Error('Configure Slack or explicitly enable local mode');
  if (s !== undefined && (!plain(s) || (s.enabled !== undefined && typeof s.enabled !== 'boolean'))) throw Error('Invalid Slack configuration');
  if (s?.servers !== undefined && !grant(s.servers, id => profiles.has(id))) throw Error('slack.servers must list unique canonical server IDs');
  if (s === undefined || s.enabled === false) {
    if (c.local?.enabled === false) throw Error('At least one transport must be enabled');
    c.slack = {enabled:false, teamId:'', inputChannel:'', outputChannel:'', allowedHumans:[],approvalUsers:[],trustedBots:[],dot:{name:''},servers:[]};
    return;
  }
  if (!/^T[A-Z0-9]+$/.test(s.teamId) || !/^[CG][A-Z0-9]+$/.test(s.inputChannel) || !/^[CG][A-Z0-9]+$/.test(s.outputChannel)) throw Error('Explicit workspace/input/output channel IDs required');
  if (!ids(s.allowedHumans, /^U[A-Z0-9]+$/, true) || !ids(s.approvalUsers, /^U[A-Z0-9]+$/) || s.approvalUsers.some(u => !s.allowedHumans.includes(u))) throw Error('approvalUsers must be explicit allowed human user IDs');
  if (!Array.isArray(s.trustedBots) || s.trustedBots.some(b => !b || !/^B[A-Z0-9]+$/.test(b.botId) || !/^U[A-Z0-9]+$/.test(b.userId) || !/^A[A-Z0-9]+$/.test(b.appId))) throw Error('trustedBots need exact botId/userId/appId');
  if (s.trustedBots.some(b => s.approvalUsers.includes(b.userId))) throw Error('A trusted bot cannot be an approval human');
  if (!s.dot || typeof s.dot.name !== 'string' || !s.dot.name.trim() || (s.dot.userId && !/^U[A-Z0-9]+$/.test(s.dot.userId))) throw Error('Set dot name and optional stable userId');
}
function configureAgents(c: Config, profiles: Map<string,BackendProfile>): void {
  const agents = c.local?.agents;
  if (agents === undefined) return;
  if (!Array.isArray(agents) || agents.length > 64) throw Error('Invalid local agents');
  const names = new Set<string>(), hashes = new Set<string>();
  for (const agent of agents) {
    if (!keys(agent, ['id','tokenHash','servers','projects','commands']) || !validServerId(agent.id) || names.has(agent.id)) throw Error('Invalid or duplicate local agent ID');
    if (typeof agent.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(agent.tokenHash) || hashes.has(agent.tokenHash)) throw Error('Invalid or duplicate local agent token hash');
    if (!grant(agent.servers, id => profiles.has(id)) || !grant(agent.projects,id => Object.hasOwn(c.projects,id))) throw Error('Agent grants require configured canonical server and project IDs');
    if (!grant(agent.commands, key => key === 'session.events' || Object.hasOwn(COMMANDS,key) && !['approval-decision','input-decision'].includes(COMMANDS[key as keyof typeof COMMANDS].permission))) throw Error('Agent grants require known non-decision commands');
    names.add(agent.id); hashes.add(agent.tokenHash);
  }
}
export function parseConfig(raw: unknown): Config {
  if (!plain(raw) || raw.version !== 2) throw Error('Config version 2 required; back up old state/config before migrating.');
  const c = { ...raw } as unknown as Config;
  if (typeof c.instanceId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.instanceId)) throw Error('Invalid instanceId');
  if (c.local !== undefined && (!keys(c.local,['enabled','agents']) || (c.local.enabled !== undefined && typeof c.local.enabled !== 'boolean'))) throw Error('Invalid local transport configuration');
  if (c.screenPolicy !== undefined && (!keys(c.screenPolicy,['enabled']) || typeof c.screenPolicy.enabled !== 'boolean')) throw Error('Invalid local screenPolicy');
  if (c.filePolicy !== undefined && (!keys(c.filePolicy,['allowAbsolutePaths']) || typeof c.filePolicy.allowAbsolutePaths !== 'boolean')) throw Error('Invalid local filePolicy');
  if (c.sessionPolicy !== undefined && (!keys(c.sessionPolicy,['allowAllSharedSessions']) || typeof c.sessionPolicy.allowAllSharedSessions !== 'boolean')) throw Error('Invalid local sessionPolicy');
  if (!plain(c.projects) || (!Object.keys(c.projects).length && c.filePolicy?.allowAbsolutePaths !== true)) throw Error('Configure explicit project aliases unless absolute file access is locally enabled');
  c.projects = {...c.projects};
  for (const [key, value] of Object.entries(c.projects)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key) || key in Object.prototype || key === 'prototype' || typeof value !== 'string' || !isAbsolute(value)) throw Error('Projects require aliases and absolute directories');
    const real = realpathSync(value);
    if (!statSync(real).isDirectory() || /(^|[\\/])(?:\.codex|\.ssh|\.aws)([\\/]|$)/i.test(real)) throw Error('Project root is restricted');
    c.projects[key] = real;
  }
  const profiles = registry(c);
  configureSlack(c,profiles); configureAgents(c,profiles);
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) throw Error('Invalid API port');
  if (!Number.isInteger(c.approvalTimeoutSec) || c.approvalTimeoutSec < 30 || c.approvalTimeoutSec > 1800) throw Error('Approval timeout must be 30–1800 seconds');
  return c;
}
export const loadConfig = (dir = home()): Config => parseConfig(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')));
export function readToken(dir = home()): string {
  const token = (process.env.CONNECTOR_TOKEN || readFileSync(join(dir, 'api.token'), 'utf8')).trim();
  if (token.length < 32) throw Error('Local token too short'); return token;
}
