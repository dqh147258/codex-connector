import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, posix, win32, parse } from 'node:path';

export type FileErrorCode = 'ROOT_UNKNOWN' | 'PATH_FORBIDDEN' | 'NOT_FOUND' | 'NOT_REGULAR' | 'LIMIT_EXCEEDED' | 'SENSITIVE_CONTENT' | 'FILE_CHANGED' | 'IO_ERROR' | 'INVALID_ARGUMENT' | 'ABSOLUTE_PATHS_DISABLED' | 'ACCESS_DENIED';
export class FileAccessError extends Error {
  constructor(readonly code: FileErrorCode) { super(code); this.name = 'FileAccessError'; }
}
export interface FileLimits { maxReadBytes: number; maxFileBytes: number; maxEntries: number; maxDepth: number; maxFiles: number; maxMatches: number; maxSearchBytes: number }
export interface FileEntry { path: string; type: 'file' | 'directory'; size: number; modifiedAt: string }
const DEFAULTS: FileLimits = { maxReadBytes: 65536, maxFileBytes: 1024 * 1024, maxEntries: 200, maxDepth: 8, maxFiles: 1000, maxMatches: 100, maxSearchBytes: 4 * 1024 * 1024 };
const DENIED_NAMES = new Set(['.git', '.git-credentials', '.gitconfig', '.config', '.local', '.cache', '.bash_history', '.zsh_history', '.history', '.bashrc', '.zshrc', '.profile', '.bash_profile', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.codex', '.codex-connector', '.npmrc', '.pypirc', '.netrc', '.docker', 'credentials', '.credentials', 'credentials.json', 'credentials.yml', 'credentials.yaml', 'secrets', '.secrets', 'secrets.json', 'secrets.yml', 'secrets.yaml', 'auth.json', 'api.token', 'service.env', 'daemon.env', 'state.json', 'config.local.json', 'shadow', 'gshadow', 'master.passwd', 'opasswd', 'keychains', 'dslocal', 'vault', 'protect', 'cookies', 'login data', 'web data', 'logins.json']);
const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  /\b(?:xox[baprs]-|xapp-)[A-Za-z0-9-]{16,}/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/,
  /(?:["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret[_-]?key)["']?\s*[:=]\s*["'])(?!["']|\$\{|process\.env|REPLACE|example|dummy|test)[^\r\n"']{8,}["']/i,
];
export function containsSensitiveContent(text: string): boolean { return SECRET_PATTERNS.some(pattern => pattern.test(text)); }
const forbidden = () => new FileAccessError('PATH_FORBIDDEN');
function safeName(name: string): boolean {
  const lower = name.toLowerCase();
  return !DENIED_NAMES.has(lower) && !/^(?:shadow|gshadow|master\.passwd|opasswd)(?:[-.~]|$)/.test(lower) && !lower.startsWith('.env') && !/^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(lower)
    && !/\.(?:pem|p12|pfx|key|keystore|kdbx|sqlite|sqlite3|db|token)$/i.test(name)
    && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)
    && !/[\x00-\x1f\x7f\\:]/.test(name) && !/[. ]$/.test(name);
}
function parts(path: string): string[] {
  if (typeof path !== 'string' || path.length > 2048 || isAbsolute(path) || /^[A-Za-z]:/.test(path) || /[\\\x00-\x1f\x7f]/.test(path)) throw forbidden();
  if (path === '' || path === '.') return [];
  const values = path.split('/');
  if (values.some(v => !v || v === '.' || v === '..' || !safeName(v))) throw forbidden();
  return values;
}
/** Syntax/policy-only root validation, separately testable for Windows paths. */
export function validateRootSyntax(root: string, windows = process.platform === 'win32'): void {
  const paths = windows ? win32 : posix;
  if (typeof root !== 'string' || !paths.isAbsolute(root) || /[\x00-\x1f\x7f]/.test(root) || (windows && /^[\\/]{2}/.test(root))) throw forbidden();
  const full = paths.resolve(root), anchor = paths.parse(full).root;
  if (full === anchor || (!windows && /^(?:\/dev|\/proc|\/sys)(?:\/|$)/.test(full))) throw forbidden();
  if (full.slice(anchor.length).split(/[\\/]/).some(p => p && !safeName(p))) throw forbidden();
}
/** Validate native absolute syntax BEFORE any filesystem operation. No expansion,
 * drive-relative paths, UNC/device namespaces, dot traversal or short-name aliases. */
export function absolutePathSyntax(path:string, windows=process.platform==='win32'):{full:string;anchor:string;components:string[]} {
  const paths=windows?win32:posix;
  if(typeof path!=='string'||!path||path.length>2048||/[\x00-\x1f\x7f]/.test(path))throw forbidden();
  if(windows){if(!/^[A-Za-z]:[\\/]/.test(path)||/^[\\/]{2}/.test(path))throw forbidden();}
  else if(!path.startsWith('/')||path.startsWith('//')||path.includes('\\'))throw forbidden();
  const anchor=paths.parse(path).root,tail=path.slice(anchor.length);
  const components=tail?tail.split(windows?/[\\/]/:/\//):[];
  if(components.some(p=>!p||p==='.'||p==='..'||!safeName(p)||(windows&&/~[0-9]/.test(p))))throw forbidden();
  const full=paths.join(anchor,...components),lower=full.replaceAll('\\','/').toLowerCase();
  if(!windows&&/^\/(?:dev|proc|sys)(?:\/|$)/.test(lower))throw forbidden();
  if(windows&&/^[a-z]:\/windows\/(?:system32|syswow64|sysnative)\/config(?:\/|$)/.test(lower))throw forbidden();
  return{full,anchor,components};
}
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); }
function same(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs; }
function bounded(value: unknown, max: number, fallback = max): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw new FileAccessError('INVALID_ARGUMENT');
  return value;
}
function normalizeError(error: unknown): never {
  if (error instanceof FileAccessError) throw error;
  if (['EACCES','EPERM'].includes((error as NodeJS.ErrnoException)?.code||'')) throw new FileAccessError('ACCESS_DENIED');
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new FileAccessError('NOT_FOUND');
  throw new FileAccessError('IO_ERROR');
}

/** Read-only filesystem service: alias-relative by default, native absolute paths only after explicit local opt-in. No methods create/modify files.
 * Node lacks portable descriptor-relative openat2. Component lstat, O_NOFOLLOW,
 * identity checks and post-read validation reject ordinary link/race changes,
 * but roots must not be concurrently rewritten by a hostile local OS principal.
 */
export class ReadonlyFiles {
  private readonly roots: Record<string, string>;
  private readonly limits: FileLimits;
  constructor(roots: Record<string, string>, limits: Partial<FileLimits> = {}, private readonly allowAbsolutePaths = false) {
    this.roots = { ...roots }; this.limits = { ...DEFAULTS, ...limits };
    if (!roots || (!Object.keys(roots).length&&!allowAbsolutePaths)) throw new FileAccessError('ROOT_UNKNOWN');
    for (const [alias, root] of Object.entries(roots)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(alias) || typeof root !== 'string' || !isAbsolute(root)) throw forbidden();
      validateRootSyntax(root);
    }
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < (key === 'maxDepth' ? 0 : 1) || value > DEFAULTS[key as keyof FileLimits]) throw new FileAccessError('INVALID_ARGUMENT');
    }
  }
  get absolutePathsEnabled(){return this.allowAbsolutePaths;}
  private async checked(rootAlias: string | undefined, path: string): Promise<{ root: string; full: string; stats: BigIntStats; path: string }> {
    if(rootAlias===undefined){
      if(!this.allowAbsolutePaths)throw new FileAccessError('ABSOLUTE_PATHS_DISABLED');
      const {full,anchor,components}=absolutePathSyntax(path);let at=anchor,stats=await lstat(anchor,{bigint:true});
      if(!stats.isDirectory()||stats.isSymbolicLink())throw forbidden();
      for(const [index,component]of components.entries()){at=join(at,component);stats=await lstat(at,{bigint:true});if(stats.isSymbolicLink()||(!stats.isDirectory()&&!stats.isFile())||(index<components.length-1&&!stats.isDirectory())||(stats.isFile()&&stats.nlink>1n))throw forbidden();}
      const canonical=await realpath(full);if(canonical!==full)throw forbidden();
      return{root:anchor,full,stats,path:full};
    }
    if (!Object.hasOwn(this.roots, rootAlias)) throw new FileAccessError('ROOT_UNKNOWN');
    const components = parts(path), configured = resolve(this.roots[rootAlias]!);
    // Walk root ancestors without following an earlier symlink/junction into
    // a protected directory before validating the final root itself.
    const anchor = parse(configured).root; let ancestor = anchor;
    let rootStat = await lstat(anchor, { bigint: true });
    for (const component of configured.slice(anchor.length).split(sep).filter(Boolean)) {
      ancestor = join(ancestor, component); rootStat = await lstat(ancestor, { bigint: true });
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw forbidden();
    }
    const root = await realpath(configured);
    // A configured symlink/junction itself is never silently expanded.
    if (root !== configured && process.platform !== 'win32') throw forbidden();
    validateRootSyntax(root);
    let full = root, stats = rootStat;
    for (const [index, component] of components.entries()) {
      full = join(full, component); stats = await lstat(full, { bigint: true });
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) throw forbidden();
      if (index < components.length - 1 && !stats.isDirectory()) throw forbidden();
      if (stats.isFile() && stats.nlink > 1n) throw forbidden();
    }
    const canonical = await realpath(full);
    if (!inside(root, canonical) || canonical !== full) throw forbidden();
    return { root, full, stats, path: components.join('/') || '.' };
  }
  private entry(path: string, stats: BigIntStats): FileEntry {
    return { path, type: stats.isDirectory() ? 'directory' : 'file', size: Number(stats.size), modifiedAt: new Date(Number(stats.mtimeMs)).toISOString() };
  }
  async stat(root: string | undefined, path = '.'): Promise<FileEntry> {
    try { const file = await this.checked(root, path); return this.entry(file.path, file.stats); } catch (e) { normalizeError(e); }
  }
  async list(root: string | undefined, path = '.', options: { limit?: number } = {}): Promise<{ entries: FileEntry[]; truncated: boolean }> {
    try {
      const limit = bounded(options.limit, this.limits.maxEntries), directory = await this.checked(root, path);
      if (!directory.stats.isDirectory()) throw new FileAccessError('NOT_REGULAR');
      const entries: FileEntry[] = []; let checked = 0, truncated = false;
      for await (const dirent of await opendir(directory.full)) {
        const name = dirent.name;
        if (++checked > this.limits.maxFiles || entries.length >= limit) { truncated = true; break; }
        if (!safeName(name)) continue;
        try { const item = await this.checked(root, root===undefined?join(directory.path,name):directory.path === '.' ? name : `${directory.path}/${name}`); entries.push(this.entry(item.path, item.stats)); }
        catch (e) { if (!(e instanceof FileAccessError) && !['ENOENT','EACCES','EPERM'].includes((e as NodeJS.ErrnoException).code||'')) throw e; }
      }
      entries.sort((a, b) => a.path.localeCompare(b.path));
      const after = await this.checked(root, path);
      if (after.stats.dev !== directory.stats.dev || after.stats.ino !== directory.stats.ino) throw new FileAccessError('FILE_CHANGED');
      return { entries, truncated };
    } catch (e) { normalizeError(e); }
  }
  private async bytes(root: string | undefined, path: string): Promise<Buffer> {
    const file = await this.checked(root, path);
    if (!file.stats.isFile()) throw new FileAccessError('NOT_REGULAR');
    if (file.stats.size > BigInt(this.limits.maxFileBytes)) throw new FileAccessError('LIMIT_EXCEEDED');
    const handle = await open(file.full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink > 1n || !same(file.stats, before)) throw new FileAccessError('FILE_CHANGED');
      // Never trust a stale size after a concurrent append. Read at most limit+1.
      const buffer = Buffer.alloc(this.limits.maxFileBytes + 1); let length = 0;
      while (length < buffer.length) { const chunk = await handle.read(buffer, length, buffer.length - length, length); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
      if (length > this.limits.maxFileBytes) throw new FileAccessError('LIMIT_EXCEEDED');
      const after = await handle.stat({ bigint: true }), current = await this.checked(root, path);
      if (!same(before, after) || !same(after, current.stats)) throw new FileAccessError('FILE_CHANGED');
      const content = buffer.subarray(0, length);
      if (content.includes(0)) throw new FileAccessError('NOT_REGULAR');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); } catch { throw new FileAccessError('NOT_REGULAR'); }
      if (containsSensitiveContent(text)) throw new FileAccessError('SENSITIVE_CONTENT');
      return content;
    } finally { await handle.close(); }
  }
  async read(root: string | undefined, path: string, options: { offset?: number; maxBytes?: number } = {}): Promise<{ path: string; text: string; bytes: number; truncated: boolean; nextOffset: number }> {
    try {
      const maxBytes = bounded(options.maxBytes, this.limits.maxReadBytes), offset = options.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.limits.maxFileBytes) throw new FileAccessError('INVALID_ARGUMENT');
      const full = await this.bytes(root, path);
      // bytes() has already validated the complete file as UTF-8. Offsets and
      // returned cursors are byte positions, but pages must end at code-point
      // boundaries rather than manufacturing replacement characters.
      const continuation = (byte: number) => (byte & 0xc0) === 0x80;
      if (offset > full.length || (offset < full.length && continuation(full[offset]!))) throw new FileAccessError('INVALID_ARGUMENT');
      let end = Math.min(offset + maxBytes, full.length);
      while (end > offset && end < full.length && continuation(full[end]!)) end--;
      if (end === offset && offset < full.length) throw new FileAccessError('INVALID_ARGUMENT');
      const selected = full.subarray(offset, end);
      return { path: root===undefined?absolutePathSyntax(path).full:parts(path).join('/'), text: selected.toString('utf8'), bytes: selected.length, truncated: end < full.length, nextOffset: end };
    } catch (e) { normalizeError(e); }
  }
  async search(root: string | undefined, path: string, query: string, options: { limit?: number; maxDepth?: number } = {}): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean; scannedFiles: number; skippedFiles: number }> {
    try {
      if (typeof query !== 'string' || !query.length || query.length > 256 || /[\x00-\x1f\x7f]/.test(query)) throw new FileAccessError('INVALID_ARGUMENT');
      const limit = bounded(options.limit, this.limits.maxMatches), maxDepth = options.maxDepth ?? this.limits.maxDepth;
      if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > this.limits.maxDepth) throw new FileAccessError('INVALID_ARGUMENT');
      const matches: Array<{ path: string; line: number; text: string }> = []; let scannedFiles = 0, skippedFiles = 0, scannedBytes = 0, visited = 0, truncated = false, stopped = false;
      const walk = async (at: string, depth: number): Promise<void> => {
        if (stopped) return;
        const item = await this.checked(root, at);
        if (item.stats.isDirectory()) {
          if (depth > maxDepth) { truncated = true; return; }
          for await (const dirent of await opendir(item.full)) {
            const name = dirent.name;
            if (++visited > this.limits.maxFiles) { truncated = true; stopped = true; break; }
            if (!safeName(name)) continue;
            if (stopped) break;
            try { await walk(root===undefined?join(item.path,name):item.path === '.' ? name : `${item.path}/${name}`, depth + 1); } catch (e) { if (e instanceof FileAccessError || ['ENOENT','EACCES','EPERM'].includes((e as NodeJS.ErrnoException).code||'')) skippedFiles++; else throw e; }
          }
        } else {
          if (scannedFiles >= this.limits.maxFiles || scannedBytes + Number(item.stats.size) > this.limits.maxSearchBytes) { truncated = true; stopped = true; return; }
          scannedFiles++; scannedBytes += Number(item.stats.size);
          const content = await this.bytes(root, at);
          for (const [index, text] of content.toString('utf8').split('\n').entries()) {
            if (!text.includes(query)) continue;
            matches.push({ path: item.path, line: index + 1, text: text.slice(0, 500) });
            if (matches.length >= limit) { truncated = true; stopped = true; break; }
          }
        }
      };
      await walk(path || '.', 0);
      return { matches, truncated, scannedFiles, skippedFiles };
    } catch (e) { normalizeError(e); }
  }
}
