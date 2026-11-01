#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { SocketModeClient, LogLevel } from '@slack/socket-mode';
import { home, loadConfig, readToken } from './config.js';
import { Store } from './store.js';
import { SlackClient } from './slack.js';
import { AppServer } from './codex.js';
import { Connector } from './connector.js';
import { apiServer } from './server.js';
import { commandRequest } from './client.js';
function flags(args: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw Error('Use --option value pairs');
    out[key.slice(2)] = value;
  }
  return out;
}
const help = `codex-connector (Node 22+)\n  init\n  doctor\n  start                    Foreground daemon; Slack tokens in environment\n  create --project NAME --channel C123 [--session ID] [--mode mailbox|managed] [--title TEXT]\n  bind --project NAME --channel C123 --thread 123.456 --session ID\n  send --session ID --text TEXT     Send to mapped Slack thread\n  ask --session ID --text TEXT      Queue a Codex turn (managed) or mailbox message\n  read --session ID                Read unacknowledged mailbox messages\n  ack --session ID --jobs ID,ID     Mark mailbox messages handled\n  status [--session ID]\n  resolve --session ID --job ID     AFTER manual inspection, unblock WITHOUT replay\nUse --text-file PATH (or - for stdin) instead of --text for multiline content.\nCONNECTOR_HOME selects the config/state directory. No Slack tokens are needed for client commands.`;
async function start() {
  const config = loadConfig(), token = readToken();
  const appToken = process.env.SLACK_APP_TOKEN, botToken = process.env.SLACK_BOT_TOKEN;
  if (!appToken?.startsWith('xapp-') || !botToken?.startsWith('xoxb-')) throw Error('Set SLACK_APP_TOKEN and SLACK_BOT_TOKEN in the daemon environment');
  const store = new Store(home());
  const slack = new SlackClient(botToken), codex = new AppServer(config), connector = new Connector(config, store, slack, codex);
  const socket = new SocketModeClient({ appToken, logLevel: LogLevel.ERROR });
  const server = apiServer(connector, token);
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    const httpClosed = new Promise<void>((resolve, reject) => server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    await socket.disconnect().catch(() => {}); await httpClosed; await connector.close(); store.close();
  };
  process.once('SIGINT', () => { void stop().catch(() => { console.error('Shutdown incomplete; retain daemon.lock and inspect local processes before restarting.'); process.exitCode = 1; }); }); process.once('SIGTERM', () => { void stop().catch(() => { console.error('Shutdown incomplete; retain daemon.lock and inspect local processes before restarting.'); process.exitCode = 1; }); });
  socket.on('message', async ({ body, ack }: any) => {
    try {
      const id = await connector.accept(body);
      await ack();
      if (id) connector.pump(id);
    } catch {
      // No ack on storage/queue failure: Slack can retry. Never log message or credential payloads.
      process.stderr.write('Slack event could not be durably accepted; check disk/queue health.\n');
    }
  });
  socket.on('error', () => process.stderr.write('Slack connection error; SDK reconnect is active.\n'));
  try {
    const auth = await slack.web.auth.test();
    if (auth.team_id !== config.teamId) throw Error('Bot token workspace does not match configured teamId');
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
    await socket.start(); connector.resumeQueues();
    process.stdout.write(`codex-connector listening on 127.0.0.1:${config.port}; Socket Mode connected.\n`);
  } catch { await stop(); throw Error('Daemon startup failed. Check configuration, workspace IDs, Slack credentials, port availability, and network access.'); }
}
async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  if (command === 'init') {
    const dir = home(); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const configPath = join(dir, 'config.json'), tokenPath = join(dir, 'api.token');
    if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify({ teamId: 'T_REPLACE', allowedUsers: ['U_REPLACE'], allowedChannels: ['C_REPLACE'], projects: { demo: '/absolute/path/to/project' }, port: 17381, codexExecutable: '/absolute/path/to/codex', sandbox: 'read-only' }, null, 2), { mode: 0o600, flag: 'wx' });
    if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    chmodSync(tokenPath, 0o600); console.log(`Initialized ${dir}. Edit config.json; no credentials were printed.`); return;
  }
  if (command === 'doctor') {
    const c = loadConfig(); readToken();
    if (!existsSync(c.codexExecutable)) throw Error('Configured Codex executable does not exist');
    console.log('Local configuration, project paths, token, and Codex executable path are valid. No Codex or Slack request was made.'); return;
  }
  if (command === 'start') { await start(); return; }
  const f = flags(args), config = loadConfig(), token = readToken();
  const text = f['text-file'] !== undefined ? readFileSync(f['text-file'] === '-' ? 0 : f['text-file'], 'utf8') : f.text;
  const payload = { command: command === 'bind' ? 'create' : command, id: f.session, session: f.session, project: f.project, channel: f.channel, threadTs: f.thread, mode: command === 'bind' ? 'mailbox' : f.mode, title: f.title, text, jobIds: f.jobs?.split(','), jobId: f.job };
  const result = await commandRequest(config.port, token, payload);
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Connector failed'); process.exitCode = 1; });
