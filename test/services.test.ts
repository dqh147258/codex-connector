import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateService, windowsArg, type ServiceOptions } from '../src/services.js';
const linux: ServiceOptions = { platform: 'linux', mode: 'login', nodeExecutable: '/usr/bin/node', scriptPath: '/home/alice/connector/dist/src/cli.js', workingDirectory: '/home/alice/project', configHome: '/home/alice/.codex-connector' };
const windows: ServiceOptions = { platform: 'windows', mode: 'login', nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe', scriptPath: 'C:\\Users\\alice\\connector\\dist\\src\\cli.js', workingDirectory: 'C:\\Users\\alice\\project', configHome: 'C:\\Users\\alice\\.codex-connector', user: 'PC\\alice' };
test('Linux login and prelogin templates differ, no root, no shell and no secrets embedded', () => {
  const login = generateService(linux); assert.equal(login.kind, 'systemd-user'); assert.equal(login.requiresAdmin, false); assert.match(login.content, /WantedBy=default.target/); assert.doesNotMatch(login.content, /^User=/m);
  const boot = generateService({ ...linux, mode: 'prelogin', user: 'alice' }); assert.equal(boot.kind, 'systemd-system'); assert.match(boot.content, /User=alice/); assert.match(boot.content, /WantedBy=multi-user.target/); assert.equal(boot.requiresAdmin, true);
  assert.throws(() => generateService({ ...linux, mode: 'prelogin' })); assert.throws(() => generateService({ ...linux, mode: 'prelogin', user: 'root' }));
  assert.ok(login.command.args[0]?.endsWith('/service.env')); assert.ok(!login.content.includes('/bin/sh')); assert.ok(!login.content.includes('xoxb-'));
});
test('systemd escapes parser expansions and rejects newline injection', () => {
  const result = generateService({ ...linux, scriptPath: '/home/alice/$X/%name/quote".js' });
  assert.ok(result.content.includes('$$X')); assert.ok(result.content.includes('%%name')); assert.ok(result.content.includes('quote\\".js'));
  assert.throws(() => generateService({ ...linux, workingDirectory: '/tmp/a\nExecStart=/bad' }));
});
test('macOS LaunchAgent/login and LaunchDaemon/prelogin retain explicit least privilege', () => {
  const login = generateService({ ...linux, platform: 'macos', scriptPath: '/Users/alice/a&b<test>/cli.js' });
  assert.equal(login.kind, 'launchagent'); assert.match(login.content, /a&amp;b&lt;test&gt;/); assert.doesNotMatch(login.content, /<key>UserName<\/key>/); assert.match(login.content, /<key>ProgramArguments<\/key>/);
  const boot = generateService({ ...linux, platform: 'macos', mode: 'prelogin', user: 'alice' }); assert.equal(boot.kind, 'launchdaemon'); assert.match(boot.content, /<key>UserName<\/key><string>alice<\/string>/); assert.equal(boot.requiresAdmin, true);
});
test('Windows login task never asks for highest privilege or credentials', () => {
  const result = generateService(windows); assert.match(result.content, /<LogonTrigger>/); assert.match(result.content, /<LogonType>InteractiveToken<\/LogonType>/); assert.match(result.content, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.ok(result.content.includes('&quot;')); assert.ok(!result.content.includes('Password')); assert.equal(result.requiresAdmin, false);
});
test('Windows startup explicitly uses S4U and discloses no-password limitations', () => {
  const result = generateService({ ...windows, mode: 'prelogin' }); assert.match(result.content, /<BootTrigger>/); assert.match(result.content, /<LogonType>S4U<\/LogonType>/); assert.equal(result.requiresAdmin, true); assert.ok(result.warnings.some(w => w.includes('EFS')));
  for (const user of ['SYSTEM', 'NT AUTHORITY\\SYSTEM', 'Administrator', 'S-1-5-18']) assert.throws(() => generateService({ ...windows, mode: 'prelogin', user }));
  assert.throws(() => generateService({ ...windows, user: undefined }));
});
test('Windows argv quoting does not use cmd; UNC and shell shim targets rejected', () => {
  assert.equal(windowsArg('a b'), '"a b"'); assert.equal(windowsArg('a"b'), '"a\\"b"'); assert.equal(windowsArg('C:\\end\\'), '"C:\\end\\\\"');
  assert.throws(() => generateService({ ...windows, nodeExecutable: 'C:\\node.cmd' }));
  assert.throws(() => generateService({ ...windows, scriptPath: '\\\\server\\share\\cli.js' }));
  assert.throws(() => generateService({ ...windows, scriptPath: 'C:\\x\\..\\bad.js' }));
});
