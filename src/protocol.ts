/** Strict application protocol. Slack event identity is deliberately NOT part of
 * the envelope: only the transport may authenticate and authorize an actor. */
export const START_MARKER = 'CODEX_CONNECTOR_COMMAND_BEGIN';
export const END_MARKER = 'CODEX_CONNECTOR_COMMAND_END';
export const MAX_ENVELOPE_BYTES = 32 * 1024;
export const ERROR_CODES = ['invalid_envelope', 'invalid_json', 'too_large', 'wrong_target', 'unsupported_version', 'unknown_command', 'invalid_params'] as const;
export type ProtocolErrorCode = typeof ERROR_CODES[number];
export class ProtocolError extends Error {
  constructor(readonly code: ProtocolErrorCode, message: string) { super(message); this.name = 'ProtocolError'; }
}
export type ParamType = 'string' | 'integer' | 'boolean' | 'enum' | 'answers';
export interface ParamSpec {
  type: ParamType;
  description: string;
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  values?: readonly string[];
  default?: unknown;
}
export interface CommandSpec {
  description: string;
  permission: 'read' | 'session-control' | 'approval-decision' | 'input-decision';
  capability: string;
  params: Record<string, ParamSpec>;
  examples: readonly Record<string, unknown>[];
  errors: readonly string[];
}
const ID = '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$';
const ALIAS = '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$';
const requiredId = (description: string): ParamSpec => ({ type: 'string', description, required: true, min: 1, max: 128, pattern: ID });
const session = requiredId('Connector session handle returned by create/attach/list; never choose a latest session.');
const project: ParamSpec = { type: 'string', description: 'Configured project alias, never an arbitrary working directory.', required: true, min: 1, max: 64, pattern: ALIAS };
const path: ParamSpec = { type: 'string', description: 'Relative path beneath the configured root. Traversal, symlinks, special and secret files are rejected by file policy.', min: 1, max: 1024, default: '.' };
const root: ParamSpec = { ...project, description: 'Configured read-only root alias.' };
const text: ParamSpec = { type: 'string', description: 'Literal user text; never interpreted as a shell command or RPC method.', required: true, min: 1, max: 20000 };
const correlation = {
  requestId: requiredId('Exact pending connector request ID, not a guessed Codex RPC ID.'),
  epoch: requiredId('Exact request epoch; restart, timeout, or completed requests invalidate it.'),
  sessionId: session,
  turnId: requiredId('Exact turn ID shown in the pending request.')
};
const humanMessageTs: ParamSpec = { type: 'string', min: 3, max: 32, pattern: '^\\d{1,16}\\.\\d{1,9}$', description: 'Optional bot-relay proof locator only: exact timestamp of a permitted human message in this bound output thread. The server independently fetches and verifies actor/correlation/content; this value is not authority by itself.' };
const controlErrors = ['ACTOR_REVOKED', 'SESSION_NOT_FOUND', 'SESSION_SCOPE_REVOKED', 'DIRECT_INPUT_UNAVAILABLE', 'SESSION_NOT_ATTACHED', 'SESSION_BUSY_USE_STEER_OR_QUEUE', 'METHOD_UNSUPPORTED', 'RPC_REJECTED', 'BACKEND_UNAVAILABLE', 'RPC_OUTCOME_UNCERTAIN'];
const fileErrors = ['ROOT_UNKNOWN', 'PATH_FORBIDDEN', 'NOT_FOUND', 'NOT_REGULAR', 'LIMIT_EXCEEDED', 'SENSITIVE_CONTENT', 'FILE_CHANGED', 'IO_ERROR', 'INVALID_ARGUMENT'];
export const COMMANDS = {
  help: { description: 'Show generated command reference or details for one command.', permission: 'read', capability: 'help', params: { command: { type: 'string', min: 1, max: 64, description: 'An exact command name from this registry.' } }, examples: [{}, { command: 'session.send' }], errors: ['unknown_command'] },
  capabilities: { description: 'Report negotiated server/version/platform capabilities and explicit unsupported cases.', permission: 'read', capability: 'capabilities', params: {}, examples: [{}], errors: ['not_authorized'] },
  'session.list': { description: 'List sessions visible through the supported shared-daemon API and their manageability.', permission: 'read', capability: 'session.list', params: { project: { ...project, required: false }, limit: { type: 'integer', min: 1, max: 100, default: 50, description: 'Maximum records returned.' }, cursor: { type: 'string', min: 1, max: 2048, description: 'Opaque continuation cursor returned by this server; do not invent or decode it.' } }, examples: [{ limit: 20 }], errors: ['not_authorized', 'capability_unavailable', 'connection_lost'] },
  'session.info': { description: 'Read one bound session and its live connection/status metadata.', permission: 'read', capability: 'session.info', params: { sessionId: session }, examples: [{ sessionId: 'session-demo' }], errors: ['not_authorized', 'unknown_session', 'capability_unavailable'] },
  'session.history': { description: 'Read a bounded session history through the supported API, never session files.', permission: 'read', capability: 'session.history', params: { sessionId: session, cursor: {type:'string',min:1,max:2048,description:'Opaque nextCursor returned by a previous history page.'}, limit: { type: 'integer', min: 1, max: 100, default: 20, description: 'Maximum history records returned.' } }, examples: [{ sessionId: 'session-demo', limit: 10 }], errors: ['not_authorized', 'unknown_session', 'capability_unavailable'] },
  'session.create': { description: 'Create a new Codex session in an explicitly configured project and bind one Slack thread.', permission: 'session-control', capability: 'session.create', params: { project, title: { type: 'string', min: 1, max: 200, description: 'Optional human-readable session title.' } }, examples: [{ project: 'demo', title: 'Review project structure' }], errors: controlErrors },
  'session.attach': { description: 'Attach an explicitly selected shared-daemon thread; unmanageable or independently isolated sessions remain unsupported.', permission: 'session-control', capability: 'session.attach', params: { threadId: requiredId('Exact Codex thread ID returned by supported discovery.'), project: { ...project, required: false, description: 'Optional configured project alias. Omit only for discovered sessions allowed by local sessionPolicy; this never expands file roots.' } }, examples: [{ threadId: 'thread-demo', project: 'demo' }], errors: [...controlErrors, 'already_bound', 'project_mismatch'] },
  'session.send': { description: 'Submit a literal message to a bound session using its supported idle/shared-daemon route.', permission: 'session-control', capability: 'session.send', params: { sessionId: session, text }, examples: [{ sessionId: 'session-demo', text: 'Explain the repository; do not edit files.' }], errors: controlErrors },
  'session.reply': { description: 'Send explicit Skill progress or a reply to this session’s mapped Slack output thread without invoking Codex. The configured channel and dot mention cannot be overridden.', permission: 'session-control', capability: 'session.reply', params: { sessionId: session, text }, examples: [{ sessionId: 'session-demo', text: 'Progress: repository inspection is complete.' }], errors: ['not_authorized', 'unknown_session', 'delivery_pending', 'delivery_failed'] },
  'session.queue': { description: 'Queue a message through a supported queue mechanism without overlapping an active turn.', permission: 'session-control', capability: 'session.queue', params: { sessionId: session, text, resume: { type: 'boolean', default: false, description: 'Explicitly request resume only if the negotiated queue capability supports it.' } }, examples: [{ sessionId: 'session-demo', text: 'Next, summarize the findings.' }], errors: controlErrors },
  'session.steer': { description: 'Steer exactly the identified active turn; never silently target another turn.', permission: 'session-control', capability: 'session.steer', params: { sessionId: session, turnId: requiredId('Exact current active turn ID.'), text }, examples: [{ sessionId: 'session-demo', turnId: 'turn-demo', text: 'Focus on tests first.' }], errors: controlErrors },
  'session.interrupt': { description: 'Interrupt exactly the identified active turn without elevating permissions.', permission: 'session-control', capability: 'session.interrupt', params: { sessionId: session, turnId: requiredId('Exact current active turn ID.') }, examples: [{ sessionId: 'session-demo', turnId: 'turn-demo' }], errors: controlErrors },
  'approval.list': { description: 'List live pending approval requests and their exact correlation fields; never grant approval.', permission: 'read', capability: 'approval.relay', params: { sessionId: { ...session, required: false } }, examples: [{ sessionId: 'session-demo' }], errors: ['not_authorized', 'unknown_session'] },
  'approval.respond': { description: 'Resolve one exact live approval request after actor, thread, epoch, turn and requested scope validation. No session/global approvals.', permission: 'approval-decision', capability: 'approval.relay', params: { ...correlation, humanMessageTs, decision: { type: 'enum', values: ['accept', 'decline', 'cancel'], required: true, description: 'One-request decision only; no acceptForSession, policy change, or arbitrary permissions.' } }, examples: [{ requestId: 'request-demo', epoch: 'epoch-demo', sessionId: 'session-demo', turnId: 'turn-demo', decision: 'decline' }], errors: ['NEED_VERIFIABLE_HUMAN_DECISION', 'STALE_OR_MISROUTED_REQUEST', 'DECISION_NOT_AVAILABLE', 'WRONG_REQUEST_KIND', 'HUMAN_PROOF_MISMATCH', 'RPC_OUTCOME_UNCERTAIN'] },
  'input.respond': { description: 'Answer one exact pending user-input request. The relay separately checks question IDs and allowed options.', permission: 'input-decision', capability: 'input.relay', params: { ...correlation, humanMessageTs, answers: { type: 'answers', required: true, description: 'Object mapping exact question IDs to arrays of answer strings. No extra question IDs or unadvertised option values are allowed by the relay.' } }, examples: [{ requestId: 'request-demo', epoch: 'epoch-demo', sessionId: 'session-demo', turnId: 'turn-demo', answers: { question1: ['Option A'] } }], errors: ['NEED_VERIFIABLE_HUMAN_DECISION', 'STALE_OR_MISROUTED_REQUEST', 'INPUT_QUESTIONS_MISMATCH', 'INPUT_OPTION_INVALID', 'INPUT_NOT_ALLOWED', 'HUMAN_PROOF_MISMATCH'] },
  'files.list': { description: 'List bounded entries under one allowlisted root; no symlink traversal or secret names.', permission: 'read', capability: 'files.readonly', params: { root, path, limit: { type: 'integer', min: 1, max: 200, default: 100, description: 'Maximum directory entries.' } }, examples: [{ root: 'demo', path: '.', limit: 20 }], errors: fileErrors },
  'files.stat': { description: 'Read safe metadata for an allowed regular file/directory, never special or secret paths.', permission: 'read', capability: 'files.readonly', params: { root, path: { ...path, required: true } }, examples: [{ root: 'demo', path: 'README.md' }], errors: fileErrors },
  'files.read': { description: 'Read a bounded UTF-8 regular file inside an allowlisted root.', permission: 'read', capability: 'files.readonly', params: { root, path: { ...path, required: true }, offset: { type: 'integer', min: 0, max: 1048576, default: 0, description: 'Byte offset; the file layer may impose a lower read limit.' }, maxBytes: { type: 'integer', min: 1, max: 65536, default: 16384, description: 'Maximum bytes to read (not a limit override).' } }, examples: [{ root: 'demo', path: 'README.md', maxBytes: 4096 }], errors: fileErrors },
  'files.search': { description: 'Search for a literal string in bounded readable files, with no regular expression or shell execution.', permission: 'read', capability: 'files.readonly', params: { root, path, query: { type: 'string', required: true, min: 1, max: 256, description: 'Literal case-sensitive text to find.' }, limit: { type: 'integer', min: 1, max: 100, default: 20, description: 'Maximum matching records.' }, maxDepth: { type: 'integer', min: 0, max: 8, default: 3, description: 'Maximum directory descent depth.' } }, examples: [{ root: 'demo', path: 'src', query: 'TODO', limit: 10 }], errors: fileErrors }
} as const satisfies Record<string, CommandSpec>;
export type CommandName = keyof typeof COMMANDS;
export interface CommandEnvelope { v: 1; id: string; target: string; command: CommandName; params: Record<string, unknown> }
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value); return proto === Object.prototype || proto === null;
}
function fail(code: ProtocolErrorCode, message: string): never { throw new ProtocolError(code, message); }

/** JSON.parse accepts duplicate keys. Reject them (including escaped duplicates)
 * before interpreting authority/command fields, and reject prototype keys at any depth. */
function strictJson(source: string): unknown {
  let index = 0;
  const ws = () => { while (index < source.length && /[\t\n\r ]/.test(source[index]!)) index++; };
  const string = (): string => {
    const begin = index; index++;
    while (index < source.length) {
      const char = source[index++];
      if (char === '\\') { index++; continue; }
      if (char === '"') {
        let decoded: string;
        try { decoded = JSON.parse(source.slice(begin, index)); } catch { fail('invalid_json', 'Invalid JSON string.'); }
        if (decoded.includes(START_MARKER) || decoded.includes(END_MARKER)) fail('invalid_envelope', 'Reserved markers cannot occur inside the envelope.');
        return decoded;
      }
    }
    return fail('invalid_json', 'Unterminated JSON string.');
  };
  const value = (depth: number): unknown => {
    if (depth > 12) fail('invalid_json', 'JSON nesting exceeds the protocol limit.');
    ws(); const char = source[index];
    if (char === '"') return string();
    if (char === '{') {
      index++; ws(); const result: Record<string, unknown> = Object.create(null); const seen = new Set<string>();
      if (source[index] === '}') { index++; return result; }
      while (index < source.length) {
        ws(); if (source[index] !== '"') fail('invalid_json', 'JSON object keys must be strings.');
        const key = string();
        if (seen.has(key) || dangerousKeys.has(key)) fail('invalid_json', 'Duplicate or forbidden JSON object key.');
        seen.add(key); ws(); if (source[index++] !== ':') fail('invalid_json', 'Missing JSON property separator.');
        result[key] = value(depth + 1); ws();
        const separator = source[index++]; if (separator === '}') return result;
        if (separator !== ',') fail('invalid_json', 'Invalid JSON object separator.');
      }
      return fail('invalid_json', 'Unterminated JSON object.');
    }
    if (char === '[') {
      index++; ws(); const result: unknown[] = [];
      if (source[index] === ']') { index++; return result; }
      while (index < source.length) {
        result.push(value(depth + 1)); ws(); const separator = source[index++];
        if (separator === ']') return result;
        if (separator !== ',') fail('invalid_json', 'Invalid JSON array separator.');
      }
      return fail('invalid_json', 'Unterminated JSON array.');
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(index));
    if (!token) fail('invalid_json', 'Invalid JSON value.');
    index += token[0].length; return JSON.parse(token[0]);
  };
  const result = value(0); ws(); if (index !== source.length) fail('invalid_json', 'Trailing JSON data is forbidden.'); return result;
}
function validateParam(value: unknown, spec: ParamSpec): boolean {
  if (spec.type === 'string') return typeof value === 'string' && value.trim().length > 0 && value.length >= (spec.min ?? 0) && value.length <= (spec.max ?? Infinity) && (!spec.pattern || new RegExp(spec.pattern).test(value));
  if (spec.type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value) && value >= (spec.min ?? -Infinity) && value <= (spec.max ?? Infinity);
  if (spec.type === 'boolean') return typeof value === 'boolean';
  if (spec.type === 'enum') return typeof value === 'string' && !!spec.values?.includes(value);
  if (!plain(value)) return false;
  const entries = Object.entries(value); if (!entries.length || entries.length > 32) return false;
  return entries.every(([key, answers]) => !dangerousKeys.has(key) && new RegExp(ID).test(key) && Array.isArray(answers) && answers.length <= 16 && answers.every(answer => typeof answer === 'string' && answer.length <= 4000));
}
export function validateCommand(command: unknown, params: unknown): Record<string, unknown> {
  if (typeof command !== 'string' || !own(COMMANDS, command)) fail('unknown_command', 'Unknown command. Use help for supported commands.');
  if (!plain(params)) fail('invalid_params', 'Command params must be a plain object.');
  const spec: CommandSpec = COMMANDS[command as CommandName];
  for (const key of Object.keys(params)) if (dangerousKeys.has(key) || !own(spec.params, key)) fail('invalid_params', 'Unexpected command parameter.');
  for (const [key, param] of Object.entries(spec.params)) {
    if (!own(params, key)) { if (param.required) fail('invalid_params', `Missing required parameter: ${key}.`); continue; }
    if (!validateParam(params[key], param)) fail('invalid_params', `Invalid parameter: ${key}.`);
  }
  if (command === 'help' && own(params, 'command') && !own(COMMANDS, params.command as string)) fail('unknown_command', 'Unknown help command.');
  const normalized={...params};
  for(const [key,param] of Object.entries(spec.params))if(!own(normalized,key)&&param.default!==undefined)normalized[key]=structuredClone(param.default);
  return normalized;
}
export function parseEnvelope(text: string, target: string): CommandEnvelope {
  if (typeof text !== 'string') fail('invalid_envelope', 'Command message must be text.');
  if (Buffer.byteLength(text, 'utf8') > MAX_ENVELOPE_BYTES) fail('too_large', 'Command envelope exceeds 32 KiB.');
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.includes('\r') || !normalized.startsWith(START_MARKER + '\n') || !normalized.endsWith('\n' + END_MARKER)) fail('invalid_envelope', 'Use exactly the start marker, JSON object, and end marker on separate lines; no surrounding text.');
  const body = normalized.slice(START_MARKER.length + 1, -END_MARKER.length - 1);
  if (body.includes(START_MARKER) || body.includes(END_MARKER)) fail('invalid_envelope', 'Reserved markers cannot occur inside the envelope.');
  const data = strictJson(body);
  if (!plain(data)) fail('invalid_envelope', 'Envelope must be one JSON object.');
  const keys = ['v', 'id', 'target', 'command', 'params'];
  if (Object.keys(data).length !== keys.length || keys.some(key => !own(data, key))) fail('invalid_envelope', 'Envelope must contain exactly v, id, target, command and params.');
  if (data.v !== 1) fail('unsupported_version', 'Only envelope version 1 is supported.');
  if (typeof data.id !== 'string' || data.id.length < 8 || !new RegExp(ID).test(data.id)) fail('invalid_envelope', 'Envelope ID must be 8–128 safe identifier characters and unique per command.');
  if (typeof data.target !== 'string' || !new RegExp(ID).test(data.target)) fail('invalid_envelope', 'Invalid connector target.');
  if (data.target !== target) fail('wrong_target', 'Command is addressed to a different connector.');
  const params = validateCommand(data.command, data.params);
  return { v: 1, id: data.id, target: data.target, command: data.command as CommandName, params };
}
export function commandHelp(command?: string) {
  if (command !== undefined && !own(COMMANDS, command)) fail('unknown_command', 'Unknown help command.');
  const names = command ? [command as CommandName] : Object.keys(COMMANDS) as CommandName[];
  return {
    protocol: { version: 1, startMarker: START_MARKER, endMarker: END_MARKER, maxBytes: MAX_ENVELOPE_BYTES, exactFields: ['v', 'id', 'target', 'command', 'params'], identity: 'Transport event metadata only; claimed actor fields are forbidden.', replay: 'Each command ID must be unique. The server persists replay/deduplication state; parsing alone does not execute or deduplicate.' },
    commonErrors: [...ERROR_CODES, 'not_authorized', 'replayed_command'],
    commands: names.map(name => ({ name, ...COMMANDS[name] }))
  };
}
export function formatHelp(command?: string): string {
  const help = commandHelp(command);
  const sections = help.commands.map(spec => {
    const params = Object.entries(spec.params).map(([name, raw]) => {
      const p = raw as ParamSpec;
      const bounds = [p.min !== undefined ? `min=${p.min}` : '', p.max !== undefined ? `max=${p.max}` : '', p.values ? `values=${p.values.join('|')}` : '', p.default !== undefined ? `default=${JSON.stringify(p.default)}` : ''].filter(Boolean).join(', ');
      return `  ${name}: ${p.type}${p.required ? ' (required)' : ' (optional)'}${bounds ? ` [${bounds}]` : ''} — ${p.description}`;
    });
    return `${spec.name} — ${spec.description}\nPermission: ${spec.permission}; capability: ${spec.capability}\n${params.length ? params.join('\n') : '  No parameters.'}\nErrors: ${spec.errors.join(', ')}\nExample params: ${JSON.stringify(spec.examples[0])}`;
  });
  return `Codex Connector protocol v1\n${START_MARKER}\n{"v":1,"id":"unique-command-id","target":"YOUR_CONNECTOR_ID","command":"help","params":{}}\n${END_MARKER}\n\nExactly one envelope per whole message. Identity comes only from trusted Slack event metadata. IDs must be unique; retries must not change content. Required capabilities depend on the negotiated Codex server.\n\n${sections.join('\n\n')}\n\nProtocol errors: ${help.commonErrors.join(', ')}`;
}
