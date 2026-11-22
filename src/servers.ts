import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import type { Backend, Config } from './types.js';

export type BackendProfile = Config['backend'];
export const validServerId = (v: unknown): v is string => typeof v === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v) && !(v in Object.prototype) && v !== 'prototype';

// Resolve known components only. Offline socket paths may not exist yet; no scanning,
// guessing, daemon launch, credential inspection, or probing for a listening socket.
export function canonicalPath(path: string): string {
  if (!path || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw Error('Invalid absolute backend path');
  let current = normalize(path);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = join(realpathSync.native(current), ...tail);
      return process.platform === 'win32' ? real.toLowerCase() : real;
    } catch (err) {
      if (!['ENOENT','ENOTDIR'].includes((err as NodeJS.ErrnoException).code || '')) throw Error('Backend path unavailable');
      const parent = dirname(current);
      if (parent === current) throw Error('Backend path unavailable');
      tail.unshift(basename(current)); current = parent;
    }
  }
}
function effectiveHome(profile: BackendProfile): string | null {
  // An explicit socket with no home pin claims only that socket, not the daemon's home.
  if (profile.socketPath && !profile.codexHome) return null;
  return canonicalPath(profile.codexHome || (process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), '.codex')));
}
export interface BackendTarget { readonly home: string | null; readonly socket: string | null }
function backendTarget(profile: BackendProfile): BackendTarget {
  return {home:effectiveHome(profile),socket:profile.socketPath?canonicalPath(profile.socketPath):null};
}
export function targetFingerprint(profile: BackendProfile, target = backendTarget(profile)): string {
  // Policy, aliases and version pins are NOT target identities. Socket recreation on
  // daemon restart must not invalidate the pin. Never persist or expose the raw paths.
  const launcher = normalize(profile.executable);
  return createHash('sha256').update(JSON.stringify([process.platform==='win32'?launcher.toLowerCase():launcher,target.home,target.socket])).digest('hex');
}
export function configuredServers(config: Config): Map<string, BackendProfile> {
  const map = new Map(Object.entries(config.backends || {}));
  // parseConfig expands a legacy backend + additional profiles into the canonical map.
  // Its compatibility view on .backend is not an additional entry.
  if (!map.size || (Object.prototype.propertyIsEnumerable.call(config, 'backend') && !map.has('default'))) {
    if (config.backend) map.set('default', config.backend);
  }
  return map;
}
export function defaultServer(config: Config): string | undefined {
  const profiles = configuredServers(config);
  if (config.defaultServerId !== undefined) return config.defaultServerId;
  if (profiles.has('default')) return 'default';
  return profiles.size === 1 ? profiles.keys().next().value : undefined;
}
export function resolveServerId(config: Config, selector?: string): string {
  const profiles = configuredServers(config);
  if (selector === undefined) {
    const selected = defaultServer(config);
    if (!selected) throw Error('SERVER_SELECTION_REQUIRED');
    selector = selected;
  }
  if (validServerId(selector)) {
    if (profiles.has(selector)) return selector;
    for (const [id, profile] of profiles) if (profile.aliases?.includes(selector)) return id;
  }
  throw Error('SERVER_UNAVAILABLE');
}
export function validateIdentities(profiles: ReadonlyMap<string, BackendProfile>): Map<string, BackendTarget> {
  const targets=new Map<string,BackendTarget>();
  const names = new Set<string>(), homes = new Set<string>(), sockets = new Set<string>();
  if (!profiles.size || profiles.size > 32) throw Error('Configure between 1 and 32 backend profiles');
  for (const [id, p] of profiles) {
    for (const name of [id, ...(p.aliases || [])]) {
      if (!validServerId(name) || names.has(name.toLowerCase())) throw Error('Duplicate or invalid server ID/alias');
      names.add(name.toLowerCase());
    }
    const target=backendTarget(p),{home,socket}=target;
    // An absolute socket may forward to the platform's inherited default (or
    // another registered daemon). Different socket strings do not establish
    // different physical daemons. Require a unique, verifiable Home for each.
    if (profiles.size>1 && !home) throw Error('Multiple backend profiles require codexHome on every explicit socket');
    targets.set(id,target);
    if ((home && homes.has(home)) || (socket && sockets.has(socket))) throw Error('Duplicate backend target');
    if (home) homes.add(home); if (socket) sockets.add(socket);
  }
  return targets;
}

export interface ServerObservation { checkedAt: string | null; version: string | null; homeVerified?: boolean }
export function listServers(config: Config, allowedIds: readonly string[], backends: ReadonlyMap<string, Backend>) {
  // Listing is strictly a projection. In particular do not call backend.capabilities(),
  // connect(), rpc(), probe a socket, or read filesystem metadata while serving it.
  const preferred = defaultServer(config);
  return [...configuredServers(config)].filter(([id]) => allowedIds.includes(id)).map(([serverId,p]) => {
    const backend = backends.get(serverId) as (Backend & { readonly observation?: ServerObservation }) | undefined;
    const observation = backend?.observation;
    const checkedAt = observation?.checkedAt ?? null, connected = backend?.connected === true;
    return { serverId, aliases: [...(p.aliases || [])], isDefault: serverId === preferred,
      status: connected ? 'online' : checkedAt ? 'offline' : 'unknown', connected,
      checkedAt, version: observation?.version ?? null, versionSource:'cli', homeVerified:connected && observation?.homeVerified===true };
  });
}
