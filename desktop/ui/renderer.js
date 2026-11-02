'use strict';
(() => {
  const api = window.connector;
  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const busy = new Set();
  let snapshot = null, editingConfig = null, originalProject = null, originalDot = null;
  let dirty = false, revision = 0, polling = false, preferencesBusy = false;
  let lockEligible = false, disposed = false;
  const tokenFields = [$('app-token'), $('bot-token')];
  const safeText = value => String(value ?? '').replace(/\b(?:xox[baprs]-|xapp-)[A-Za-z0-9-]+/g, '[令牌已隐藏]').slice(0, 1200);
  const text = (id, value) => { $(id).textContent = safeText(value); };
  const notice = (message, kind = 'success') => { const n = $('global-notice'); n.className = `notice ${kind}`; n.textContent = safeText(message); n.hidden = false; };
  const errorMessage = error => error?.message || '操作没有完成，请检查设置后重试。';
  async function invoke(method, params) {
    if (!api || typeof api[method] !== 'function') throw new Error('桌面连接接口不可用，请在 Codex Connector 应用中打开此页面。');
    let result;
    try { result = await api[method](params); } catch { throw new Error('本机操作未完成，请重试或查看连接诊断。'); }
    if (!result?.ok) {
      const error = new Error(safeText(result?.error?.message || '操作被拒绝，请检查配置。'));
      error.code = result?.error?.code || 'OPERATION_FAILED';
      throw error;
    }
    return result.value;
  }
  async function task(key, buttons, fn) {
    if (busy.has(key)) return;
    busy.add(key);
    const elements = buttons.map(id => $(id));
    for (const button of elements) { button.disabled = true; button.classList.add('is-busy'); button.setAttribute('aria-busy', 'true'); }
    text('busy-status', '正在处理，请稍候。');
    try { return await fn(); } catch (error) { notice(errorMessage(error), 'error'); }
    finally {
      busy.delete(key);
      for (const button of elements) { button.disabled = false; button.classList.remove('is-busy'); button.removeAttribute('aria-busy'); }
      text('busy-status', '操作已结束。');
      if (snapshot) renderState(snapshot);
    }
  }
  function go(view) {
    for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${view}`;
    for (const button of document.querySelectorAll('[data-view]')) {
      const active = button.dataset.view === view; button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
    window.scrollTo?.(0, 0);
  }
  function markDirty() { dirty = true; revision++; text('dirty-label', '有修改尚未保存'); }
  function populate(config) {
    if (!config) return;
    editingConfig = clone(config);
    const slack = config.slack || {}, backend = config.backend || {};
    originalProject = Object.keys(config.projects || {})[0] || 'demo';
    originalDot = slack.dot?.userId || slack.trustedBots?.[0]?.userId || '';
    const bot = slack.trustedBots?.find(b => b.userId === originalDot) || slack.trustedBots?.[0] || {};
    const values = {
      'instance-id': config.instanceId || 'my-computer', port: config.port || 17381,
      'team-id': slack.teamId || '', 'input-channel': slack.inputChannel || '', 'output-channel': slack.outputChannel || '',
      'allowed-humans': (slack.allowedHumans || []).join(', '), 'approval-users': (slack.approvalUsers || []).join(', '),
      'dot-user-id': originalDot, 'dot-name': slack.dot?.name || '', 'dot-bot-id': bot.botId || '', 'dot-app-id': bot.appId || '',
      'codex-path': backend.executable || '', 'project-alias': originalProject, 'project-path': config.projects?.[originalProject] || '',
      'expected-version': backend.expectedVersion || '', 'socket-path': backend.socketPath || ''
    };
    for (const [id, value] of Object.entries(values)) $(id).value = String(value);
    $('allow-all-sessions').checked = config.sessionPolicy?.allowAllSharedSessions === true;
    $('auto-start-daemon').checked = backend.autoStartDaemon === true;
    const extraProjects = Math.max(0, Object.keys(config.projects || {}).length - 1), extraBots = Math.max(0, (slack.trustedBots || []).length - 1);
    text('preserved-settings', extraProjects || extraBots ? `这份配置另有 ${extraProjects} 个项目、${extraBots} 个可信 bot，保存时会保留。此处仅编辑上面显示的项目与 dot。` : '默认只开放你选择的项目。需要时可以导入包含多个项目的现有配置。');
    dirty = false; revision++; text('dirty-label', '配置尚未修改');
  }
  const ids = value => value.split(/[\s,，]+/).map(s => s.trim()).filter(Boolean);
  function formConfig() {
    const c = clone(editingConfig || snapshot?.config || {});
    c.version = 2; c.instanceId = $('instance-id').value.trim(); c.port = Number($('port').value);
    c.slack = c.slack || {};
    Object.assign(c.slack, { teamId: $('team-id').value.trim(), inputChannel: $('input-channel').value.trim(), outputChannel: $('output-channel').value.trim(), allowedHumans: ids($('allowed-humans').value), approvalUsers: ids($('approval-users').value) });
    const userId = $('dot-user-id').value.trim();
    c.slack.dot = { name: $('dot-name').value.trim(), userId };
    c.slack.trustedBots = [...(c.slack.trustedBots || []).filter(b => b.userId !== originalDot), { userId, botId: $('dot-bot-id').value.trim(), appId: $('dot-app-id').value.trim() }];
    const alias = $('project-alias').value.trim();
    if (['__proto__', 'prototype', 'constructor'].includes(alias)) throw new Error('这个项目别名是保留名称，请换一个名称。');
    c.projects = { ...(c.projects || {}) };
    if (originalProject && alias !== originalProject && Object.hasOwn(c.projects, alias)) throw new Error('这个项目别名已被另一项目使用，请换一个名称。');
    if (originalProject && alias !== originalProject) delete c.projects[originalProject];
    c.projects[alias] = $('project-path').value.trim();
    c.sessionPolicy = { allowAllSharedSessions: $('allow-all-sessions').checked };
    c.backend = { ...(c.backend || {}), executable: $('codex-path').value.trim(), autoStartDaemon: $('auto-start-daemon').checked };
    const version = $('expected-version').value.trim(), socketPath = $('socket-path').value.trim();
    if (version) c.backend.expectedVersion = version; else delete c.backend.expectedVersion;
    if (socketPath) c.backend.socketPath = socketPath; else delete c.backend.socketPath;
    c.approvalTimeoutSec = c.approvalTimeoutSec || 300;
    return c;
  }
  const runtimeNames = { stopped: '未启动', starting: '正在启动', running: '运行中', stopping: '正在停止', failed: '启动失败' };
  const failureHelp = {
    LOCAL_PORT_IN_USE: '本地端口已被其他实例使用。请先正常停止原终端连接器，或在设置中选择另一个端口，不要强杀未知进程。',
    WORKSPACE_MISMATCH: '令牌所属工作区与设置不符。重新测试 Slack 并核对工作区 ID。',
    SLACK_AUTH_FAILED: 'Slack 令牌无效或已撤销。请在设置中重新验证并保存两个令牌。',
    CONFIGURATION_INVALID: '本地配置不完整或文件缺失。请重新检查并保存设置。',
    VERSION_MISMATCH: '实际 Codex 版本与高级设置中的显式限制不一致。可以核对版本，或由你清空可选版本限制；这不保证所有接口兼容。',
    SHARED_DAEMON_UNAVAILABLE: 'Codex 版本探测或共享连接未完成。先到设置向导检查程序路径与能力；不要据此直接认定 daemon 不存在。',
    PROXY_START_FAILED: '共享 proxy 没有启动成功。请检查程序路径和当前 CLI 是否支持 app-server proxy，不要关闭沙箱或提升权限。',
    PROXY_DISCONNECTED: '共享 proxy 已断开。服务存活时会尝试重连；不要删除会话数据或重复发送不确定的操作。',
    RPC_OUTCOME_UNCERTAIN: '共享连接或请求没有获得确定结果。先核对能力与会话状态，不要自动重跑可能已执行的操作。',
    DAEMON_START_FAILED: '官方 daemon 启动未成功或超时，本次不会自动反复启动。请核对 Codex 运行条件；连接器不会提权或改写权限。',
    EEXIST: '启动锁已存在。先点击「检查启动锁」，确认旧进程已退出后才能备份失效锁；不要直接删除配置目录。'
  };
  function dot(id, tone) { $(id).className = `status-dot ${tone || ''}`; }
  function renderState(s) {
    const runtime = s.runtime || {}, backend = runtime.backend || {}, credentials = s.credentials || {};
    const state = runtime.state || 'stopped', running = state === 'running', transitioning = state === 'starting' || state === 'stopping';
    const connected = backend.connected === true;
    const tone = connected ? 'good' : state === 'failed' ? 'error' : running || transitioning ? 'warning' : 'neutral';
    $('connection-badge').className = `badge ${tone}`;
    text('connection-badge', connected ? '共享 Codex 已连接' : running ? '本地已启动 · Codex 待连接' : runtimeNames[state] || state);
    text('connection-title', connected ? '连接已就绪，开始协作吧' : running ? '服务在运行，继续检查 Codex' : state === 'failed' ? '连接尚未完成，一起检查原因' : transitioning ? '正在安全地处理连接' : '准备好，让工作接上话');
    text('connection-description', connected ? '下一步：在测试频道发送 help，选择并绑定一个明确的 Codex 会话。不要把已连接当作所有会话都可接管。' : running ? '本地服务启动不等于共享会话连接成功。下方诊断会显示当前版本、失败原因和可采取的下一步。' : '先完成本机配置。连接器不会替你关闭 Codex 沙箱，也不会自动批准操作。');
    $('start-button').disabled = transitioning || running || busy.has('start') || busy.has('stop');
    $('stop-button').disabled = state === 'stopping' || !runtime.owned || busy.has('stop');
    $('settings-stop-button').disabled = $('stop-button').disabled;
    text('local-status', runtimeNames[state] || state); dot('local-dot', running ? 'good' : state === 'failed' ? 'error' : transitioning ? 'warning' : '');
    text('local-detail', runtime.owned ? '由本应用管理；停止不会关闭共享 Codex daemon。' : '仅管理本应用启动的连接，不会接管其他进程。');
    const tokensReady = credentials.appToken && credentials.botToken;
    text('slack-status', tokensReady ? '两种令牌已保存' : '等待配置令牌'); dot('slack-dot', tokensReady ? 'good' : '');
    text('slack-detail', tokensReady ? '凭据保存不代表授权有效，可在向导中测试。' : '需要独立的 App Token 和 Bot Token。');
    text('codex-status', connected ? '共享连接已建立' : running || transitioning ? '等待共享连接' : '尚未连接'); dot('codex-dot', connected ? 'good' : running ? 'warning' : '');
    text('codex-detail', backend.version ? `已探测版本 ${backend.version}` : '连接默认共享会话，不创建替代会话。');
    text('diagnostic-version', backend.version || '尚未探测'); text('diagnostic-pin', backend.expectedVersion || '默认不限制版本号');
    const failure = backend.lastFailure || runtime.lastError || '';
    text('diagnostic-error', failure || '无');
    const daemon = backend.daemonStart || {};
    text('diagnostic-daemon', daemon.enabled ? daemon.result || (daemon.attempted ? '已经尝试' : '等待启动') : '自动启动已关闭');
    text('diagnostic-guidance', failureHelp[failure] || (failure ? '先检查设置中的具体参数和 Codex 能力。不要发送令牌或完整配置；错误代码通常已经足够排查。' : connected ? '共享连接已建立。首次只选一个测试会话，验证 thread、回复与人工审批，然后再投入日常使用。' : running ? '如果共享连接持续未建立，请到设置向导检查 Codex 路径与能力，不要把共享目录改成宽松权限。' : '先点击「设置向导」，完成身份与项目选择，再启动连接。'));
    $('secure-storage-warning').hidden = credentials.secureStorage !== false;
    $('save-tokens-button').disabled = credentials.secureStorage === false || busy.has('tokens');
    $('test-slack-button').disabled = !tokensReady || busy.has('slack-test');
    text('tokens-status', `App Token：${credentials.appToken ? '已保存' : '未保存'} · Bot Token：${credentials.botToken ? '已保存' : '未保存'}`);
    const login = s.login || {};
    if (!busy.has('login')) $('login-startup').checked = login.enabled === true;
    $('login-startup').disabled = login.supported !== true || busy.has('login');
    text('login-status', login.supported ? `系统当前状态：${login.enabled ? '已启用登录启动' : '未启用登录启动'}${login.reason ? ` · ${login.reason}` : ''}` : login.reason || '当前系统或开发模式不支持登录启动设置。');
    if (!preferencesBusy) { $('auto-connect').checked = s.preferences?.autoConnect === true; $('close-to-tray').checked = s.preferences?.closeToTray !== false; }
    $('auto-connect').disabled = preferencesBusy; $('close-to-tray').disabled = preferencesBusy;
    $('recover-lock-button').disabled = !lockEligible || busy.has('lock-recover') || running || transitioning;
    text('platform-label', `${({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[s.platform] || '桌面'} · ${s.packaged ? '预览版' : '开发模式'}`);
  }
  async function refresh({ showError = false, forceForm = false } = {}) {
    if (polling || disposed) return;
    polling = true;
    try {
      const next = await invoke('snapshot'); snapshot = next;
      if (forceForm || !editingConfig || (!dirty && JSON.stringify(editingConfig) !== JSON.stringify(next.config))) populate(next.config);
      renderState(next);
    } catch (error) { if (showError || !snapshot) notice(errorMessage(error), 'error'); }
    finally { polling = false; }
  }
  async function start() {
    if (busy.has('start') || busy.has('stop')) return;
    if (dirty) { notice('设置还有未保存的修改。请先保存配置，再启动连接。', 'error'); go('setup'); return; }
    await task('start', ['start-button'], async () => {
      const runtime = await invoke('start');
      if (snapshot && runtime) { snapshot.runtime = runtime; renderState(snapshot); }
      await refresh({ showError: true });
      notice('启动请求已完成，请查看本地服务与共享 Codex 各自的状态。');
    });
    if (snapshot) renderState(snapshot);
  }
  async function stop() {
    if (busy.has('stop')) return;
    await task('stop', ['start-button', 'stop-button', 'settings-stop-button'], async () => {
      const runtime = await invoke('stop'); if (snapshot && runtime) snapshot.runtime = runtime;
      await refresh({ showError: true }); notice('本应用的连接已停止。共享 Codex daemon 和其他客户端不会被关闭。');
    });
    if (snapshot) renderState(snapshot);
  }
  function confirmDiscard() {
    if (!dirty) return Promise.resolve(true);
    return new Promise(resolve => {
      const dialog = $('discard-dialog');
      const finish = result => { dialog.close(); $('discard-confirm').onclick = null; $('discard-cancel').onclick = null; dialog.oncancel = null; resolve(result); };
      $('discard-confirm').onclick = () => finish(true); $('discard-cancel').onclick = () => finish(false);
      dialog.oncancel = event => { event.preventDefault(); finish(false); };
      dialog.showModal();
    });
  }
  for (const b of document.querySelectorAll('[data-view],[data-go]')) b.addEventListener('click', () => go(b.dataset.view || b.dataset.go));
  for (const b of document.querySelectorAll('[data-help]')) b.addEventListener('click', () => task(`help-${b.dataset.help}`, [], async () => {
    const result = await invoke('openHelp', { topic: b.dataset.help });
    if (result?.manifestCopied) notice('App 清单已复制到剪贴板。在 Slack 选择 Create New App → From a manifest，再粘贴清单。');
  }));
  $('config-form').addEventListener('input', markDirty);
  $('config-form').addEventListener('change', markDirty);
  $('config-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!$('config-form').reportValidity()) return;
    task('save-config', ['save-config-button'], async () => {
      const versionAtSave = revision, config = formConfig();
      const result = await invoke('saveConfig', config);
      if (revision === versionAtSave) {
        dirty = false; populate(result?.config || config); $('import-notice').hidden = true;
        text('dirty-label', '配置已保存');
      }
      if (result?.runtime) { snapshot = result; renderState(snapshot); }
      notice(revision === versionAtSave + 1 ? '配置已保存。可以回到连接概览启动服务。' : '本次提交的配置已保存；之后的新修改仍留在表单中。');
      await refresh();
    });
  });
  $('save-tokens-button').addEventListener('click', () => {
    const payload = {};
    if ($('app-token').value.trim()) payload.appToken = $('app-token').value.trim();
    if ($('bot-token').value.trim()) payload.botToken = $('bot-token').value.trim();
    for (const f of tokenFields) f.value = '';
    if (!Object.keys(payload).length) { notice('请先填写至少一种新令牌。空白字段会保留已保存的令牌。', 'error'); return; }
    task('tokens', ['save-tokens-button'], async () => {
      const credentials = await invoke('saveCredentials', payload);
      if (snapshot) snapshot.credentials = credentials;
      notice('令牌已提交安全存储，输入框已清空。已保存的令牌不会再次显示。');
      await refresh();
    });
  });
  $('test-slack-button').addEventListener('click', () => task('slack-test', ['test-slack-button'], async () => {
    const priorTeam = $('team-id').value;
    const result = await invoke('testSlack');
    if (result.teamId && $('team-id').value === priorTeam) { $('team-id').value = result.teamId; markDirty(); }
    text('slack-test-result', `工作区：${result.teamName || result.teamId || '已验证'}；Bot Token：已验证${result.appTokenValid === true ? '；App Token：已验证' : '；App Token：请查看诊断结果'}。两种令牌独立验证，不证明属于同一 App；请确认它们来自同一个 Connector App。共享 Codex 仍需另行验证。`);
    notice('Slack 身份已验证。自动填写的工作区 ID 仍需保存配置。');
  }));
  $('lookup-dot-button').addEventListener('click', () => task('dot', ['lookup-dot-button'], async () => {
    const userId = $('dot-user-id').value.trim(); if (!/^U[A-Z0-9]+$/.test(userId)) throw new Error('请先填写 dot 真实的 U… 用户 ID。');
    const result = await invoke('lookupDot', { userId });
    if ($('dot-user-id').value.trim() !== userId) { text('dot-result', '查询期间用户 ID 已改变，未应用旧结果。请重新查询。'); return; }
    $('dot-bot-id').value = result.botId; $('dot-app-id').value = result.appId; if (result.name) $('dot-name').value = result.name;
    markDirty(); text('dot-result', '已核对用户、Bot 与 App ID。请确认这是你的 dot，再保存配置。');
  }));
  $('list-users-button').addEventListener('click', () => task('users', ['list-users-button'], async () => {
    const result = await invoke('listUsers'); $('user-options').replaceChildren();
    for (const user of result.users || []) { const option = document.createElement('option'); option.value = user.id; option.label = `${user.name}${user.isBot ? ' · bot' : ''}`; $('user-options').append(option); }
    text('dot-result', result.hasMore ? '已加载首批成员，并非完整列表；找不到 dot 时请从其 Slack 资料复制用户 ID 手动填写，再点击自动查询。' : '成员列表已加载，可在 dot 用户 ID 输入框中选择。仍需点击自动查询核对 Bot / App。');
  }));
  $('list-channels-button').addEventListener('click', () => task('channels', ['list-channels-button'], async () => {
    const result = await invoke('listChannels'); $('channel-options').replaceChildren();
    for (const channel of result.channels || []) { const option = document.createElement('option'); option.value = channel.id; option.label = `#${channel.name}`; $('channel-options').append(option); }
    text('channel-result', result.manual ? `当前授权无法列出频道。可从 Slack 频道详情复制 ID 手动填写${result.requiredScopes?.length ? `；如需列表功能，先由你审查 ${result.requiredScopes.join(' / ')} 权限并重新安装 App` : ''}。` : `已读取 ${(result.channels || []).length} 个可访问频道${result.hasMore ? '（仅首批，并非完整列表；找不到时请手动填写频道 ID）' : ''}。请确认 Connector 与 dot 都已加入目标频道。`);
  }));
  $('import-button').addEventListener('click', () => task('import', ['import-button'], async () => {
    if (!await confirmDiscard()) return;
    const result = await invoke('choosePath', { kind: 'import' });
    if (!result?.config) return;
    populate(result.config); markDirty(); $('import-notice').hidden = false; go('setup'); notice('已载入配置预览；检查后保存才会应用，原文件保持不变。');
  }));
  $('browse-codex-button').addEventListener('click', () => task('browse-codex', ['browse-codex-button'], async () => { const result = await invoke('choosePath', { kind: 'executable' }); if (result?.path) { $('codex-path').value = result.path; markDirty(); } }));
  $('browse-project-button').addEventListener('click', () => task('browse-project', ['browse-project-button'], async () => { const result = await invoke('choosePath', { kind: 'project' }); if (result?.path) { $('project-path').value = result.path; markDirty(); } }));
  $('probe-codex-button').addEventListener('click', () => task('probe', ['probe-codex-button'], async () => {
    const executable = $('codex-path').value.trim(); if (!executable) throw new Error('请先选择 Codex 程序。');
    const result = await invoke('probeCodex', { executable });
    if ($('codex-path').value.trim() !== executable) { text('probe-result', '检查期间程序路径已改变，请重新检查。'); return; }
    text('probe-result', result.error ? `检查结果：${result.error}。不会据此更改权限或启动模型。` : `版本：${result.version || '未知'}；共享 proxy：${result.proxySupported ? '支持' : '未确认支持'}；daemon 启动：${result.daemonStartSupported ? '支持' : '未确认支持'}。能力探测不代表真实共享会话已连接。`);
  }));
  $('start-button').addEventListener('click', start); $('stop-button').addEventListener('click', stop); $('settings-stop-button').addEventListener('click', stop);
  $('refresh-button').addEventListener('click', () => task('refresh', ['refresh-button'], () => refresh({ showError: true })));
  $('inspect-lock-button').addEventListener('click', () => task('lock', ['inspect-lock-button'], async () => {
    const result = await invoke('inspectLock'); lockEligible = result.eligible === true;
    $('recover-lock-button').hidden = !lockEligible;
    text('lock-result', !result.exists ? '没有启动锁。可以检查其他设置后启动连接。' : `锁文件${result.pid ? `记录 PID ${result.pid}` : ''}：${result.reason || (result.alive ? '进程仍存在，不能清理。' : '状态需要核对。')}${lockEligible ? '已确认符合恢复条件；点击后仍会再次检查并请求确认，只备份旧锁。' : ''}`);
  }));
  $('recover-lock-button').addEventListener('click', () => task('lock-recover', ['recover-lock-button'], async () => {
    if (!lockEligible) throw new Error('请先检查启动锁，确认恢复条件。');
    const result = await invoke('recoverLock'); lockEligible = false; $('recover-lock-button').hidden = true;
    text('lock-result', result?.recovered ? '已备份确认失效的锁，未删除会话或配置。现在可以重试启动。' : '未执行恢复，锁与数据保持不变。');
    await refresh();
  }));
  $('login-startup').addEventListener('change', () => task('login', ['login-startup'], async () => {
    const enabled = $('login-startup').checked;
    const result = await invoke('setLoginStartup', { enabled });
    if (snapshot) snapshot.login = result;
    notice(result.enabled === enabled ? `系统登录启动已${result.enabled ? '开启' : '关闭'}。打开后是否自动连接由下面的独立开关决定。` : '系统未确认所请求的状态，已恢复显示实际状态。', result.enabled === enabled ? 'success' : 'error');
    await refresh({ showError: true });
  }));
  async function savePreferences() {
    if (preferencesBusy) return;
    preferencesBusy = true;
    const preferences = { autoConnect: $('auto-connect').checked, closeToTray: $('close-to-tray').checked };
    if (snapshot) renderState(snapshot);
    await task('preferences', [], async () => { const result = await invoke('savePreferences', preferences); if (snapshot) snapshot.preferences = result || preferences; notice('启动与后台运行偏好已保存。'); });
    preferencesBusy = false; if (snapshot) renderState(snapshot);
  }
  $('auto-connect').addEventListener('change', savePreferences); $('close-to-tray').addEventListener('change', savePreferences);
  $('quit-button').addEventListener('click', () => task('quit', ['quit-button'], () => invoke('quit')));
  const timer = window.setInterval(() => { void refresh(); }, 3000);
  window.addEventListener('pagehide', () => { disposed = true; window.clearInterval(timer); for (const f of tokenFields) f.value = ''; });
  if (!api) { notice('请在 Codex Connector 桌面应用中打开此页面。浏览器预览不能读取令牌、启动进程或更改系统设置。', 'error'); for (const button of document.querySelectorAll('button')) if (!button.dataset.view && !button.dataset.go) button.disabled = true; }
  else void refresh({ showError: true });
})();
