import { posix, win32 } from 'node:path';

export interface ServiceOptions {
  platform: 'linux' | 'macos' | 'windows'; mode: 'login' | 'prelogin'; name?: string;
  nodeExecutable: string; scriptPath: string; workingDirectory: string; configHome: string; user?: string;
}
export interface ServiceTemplate {
  filename: string; content: string; kind: 'systemd-user' | 'systemd-system' | 'launchagent' | 'launchdaemon' | 'scheduled-task';
  requiresAdmin: boolean; installInstructions: string[]; warnings: string[];
  environmentFile: string; command: { executable: string; args: string[] };
}
function clean(value: string, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) throw Error(`Invalid ${label}`);
  return value;
}
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function systemdArg(value: string): string {
  // systemd performs its own argument parsing and %/$ expansion, not a shell.
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
}
function systemdValue(value: string): string { return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"'; }
/** CommandLineToArgvW/CRT quoting, not cmd.exe or PowerShell quoting. */
export function windowsArg(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}
function userName(options: ServiceOptions): string | undefined {
  const user = options.user;
  if (options.mode === 'prelogin' && !user) throw Error('Pre-login service requires an explicit non-privileged user');
  if (user === undefined) return;
  clean(user, 'user');
  if (options.platform === 'windows') {
    if (!/^[A-Za-z0-9_.@\\ -]{1,256}$/.test(user) || /(?:^|\\)(?:system|localsystem|administrator|administrators|local service|network service)$/i.test(user) || /^S-1-5-(?:18|19|20)$/i.test(user)) throw Error('Choose a non-privileged Windows user');
  } else if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(user) || user === 'root') throw Error('Choose a non-root service user');
  return user;
}
/** Generates local-only, reviewable text. It never writes a service, invokes an
 * installer, stores a password, or elevates a process. Tokens stay in a separate
 * owner-managed environment file. Node >=22 native --env-file needs no shell.
 */
export function generateService(options: ServiceOptions): ServiceTemplate {
  if (!['linux', 'macos', 'windows'].includes(options.platform) || !['login', 'prelogin'].includes(options.mode)) throw Error('Invalid service platform or mode');
  const name = options.name ?? 'codex-connector';
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw Error('Invalid service name');
  const paths = options.platform === 'windows' ? win32 : posix;
  for (const key of ['nodeExecutable', 'scriptPath', 'workingDirectory', 'configHome'] as const) {
    clean(options[key], key);
    if (!paths.isAbsolute(options[key]) || (options.platform === 'windows' && (options[key].startsWith('\\\\') || /^[\\/]/.test(options[key])))) throw Error(`${key} must be an absolute local path`);
    if (options[key].split(/[\\/]/).some(p => p === '..')) throw Error('Service paths must not contain traversal');
  }
  if (/\.(?:cmd|bat|ps1)$/i.test(options.nodeExecutable)) throw Error('Use the native Node executable, not a shell shim');
  const user = userName(options), environmentFile = paths.join(options.configHome, 'service.env');
  const command = { executable: options.nodeExecutable, args: [`--env-file=${environmentFile}`, options.scriptPath, 'start', '--home', options.configHome] };
  const warnings = [
    'Template only: nothing has been installed, enabled, started, or elevated.',
    'Create service.env yourself with private ACLs/0600, containing Slack credentials and CONNECTOR_HOME. Never commit it or paste it into Slack.',
    'Use the same non-privileged OS account as the intended Codex daemon. Review effective Codex permissions before enabling startup.',
    'Login startup is not pre-login startup. Encrypted home directories, keychains, network availability, and Codex authentication may be unavailable before login.',
  ];
  if (options.platform === 'linux') {
    const system = options.mode === 'prelogin';
    const content = `[Unit]\nDescription=Local Codex Connector\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\n${system ? `User=${user}\n` : ''}WorkingDirectory=${systemdValue(options.workingDirectory)}\nExecStart=${[command.executable, ...command.args].map(systemdArg).join(' ')}\nRestart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=${system ? 'multi-user.target' : 'default.target'}\n`;
    return { filename: `${name}.service`, content, kind: system ? 'systemd-system' : 'systemd-user', requiresAdmin: system, environmentFile, command, warnings,
      installInstructions: system
        ? ['An administrator may review and install this unit under /etc/systemd/system with an explicit non-root User. Do not change User to root.', 'Review the generated unit and service.env permissions before manually enabling it. This is a system/pre-login service, not a user login unit.']
        : ['Review and place this unit under ~/.config/systemd/user, then manually enable it using the user systemd manager.', 'Do not enable user lingering automatically: lingering changes the service from login-scoped to pre-login behavior and requires separate operator review.'] };
  }
  if (options.platform === 'macos') {
    const system = options.mode === 'prelogin', label = `local.${name}`;
    const values = [command.executable, ...command.args].map(value => `<string>${xml(value)}</string>`).join('');
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${values}</array>\n<key>WorkingDirectory</key><string>${xml(options.workingDirectory)}</string>\n${system ? `<key>UserName</key><string>${xml(user!)}</string>\n` : ''}<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>5</integer>\n<key>Umask</key><integer>63</integer>\n</dict></plist>\n`;
    return { filename: `${label}.plist`, content, kind: system ? 'launchdaemon' : 'launchagent', requiresAdmin: system, environmentFile, command, warnings,
      installInstructions: system
        ? ['An administrator may review and place the plist in /Library/LaunchDaemons with correct root ownership of the plist. Its UserName must remain the explicit non-root runtime account.', 'Manually bootstrap the system launchd domain only after reviewing startup, credentials, and encrypted-home availability.']
        : ['Review and place the plist in ~/Library/LaunchAgents, then manually bootstrap it in your user GUI launchd domain.', 'The LaunchAgent starts only after the user logs in. Do not substitute /Library/LaunchDaemons without explicit pre-login planning.'] };
  }
  // S4U stores no account password but has important network-credential/EFS restrictions.
  // HTTPS to Slack still needs validation on the actual machine; no claim of universal boot access.
  const startup = options.mode === 'prelogin';
  if (!user) throw Error('Windows scheduled tasks require an explicit local/domain user identity');
  if (startup) warnings.push('Windows S4U startup needs Log on as a batch job rights. Microsoft documents restrictions on network resources and EFS encrypted files; Slack/Codex connectivity is not guaranteed before login. Prefer login mode if unavailable. Do not switch to SYSTEM or store a password to bypass this; validate the chosen account locally.');
  const trigger = startup ? '<BootTrigger><Enabled>true</Enabled></BootTrigger>' : `<LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger>`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n<RegistrationInfo><Description>Local Codex Connector (${options.mode})</Description></RegistrationInfo>\n<Triggers>${trigger}</Triggers>\n<Principals><Principal id="Owner"><UserId>${xml(user)}</UserId><LogonType>${startup ? 'S4U' : 'InteractiveToken'}</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>\n<Actions Context="Owner"><Exec><Command>${xml(command.executable)}</Command><Arguments>${xml(command.args.map(windowsArg).join(' '))}</Arguments><WorkingDirectory>${xml(options.workingDirectory)}</WorkingDirectory></Exec></Actions>\n</Task>\n`;
  return { filename: `${name}.task.xml`, content, kind: 'scheduled-task', requiresAdmin: startup, environmentFile, command, warnings,
    installInstructions: ['Review XML and import it through Windows Task Scheduler under the explicitly named non-privileged account. Keep RunLevel at LeastPrivilege.', startup ? 'Registering a BootTrigger/S4U task may require an administrator and batch-logon policy. No password is included or requested by this generator.' : 'This uses InteractiveToken and runs only while the named user is logged in; it does not provide pre-login service behavior.'] };
}
