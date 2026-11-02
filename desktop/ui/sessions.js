'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const panel = $('view-sessions');
  if (!panel) return;
  const entries = new Map();
  let nextCursor = null, pages = 0, reading = false, disposed = false, lastRead = '', paginationError = false;
  const seenCursors = new Set();
  const safe = (value, max = 2048) => {
    let text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
    return String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\b(?:xox[baprs]-|xapp-)[A-Za-z0-9-]+/g, '[令牌已隐藏]').slice(0, max);
  };
  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = safe(content);
    return node;
  }
  function row(list, label, value) {
    const line = element('div'); line.append(element('dt', '', label), element('dd', '', value || '未提供')); list.append(line);
  }
  function loadedLabel(item) {
    if (item.loaded === true) return '当前服务的加载记录';
    return item.loaded === false ? '历史 / 已发现（未显示为当前加载）' : '已发现（当前加载情况未确认）';
  }
  function statusLabel(item) {
    const type = typeof item.status === 'string' ? item.status : item.status?.type;
    if (item.loaded === true) {
      if (type === 'active') return 'active · 读取时执行中';
      if (type === 'idle') return 'idle · 读取时空闲';
      if (type === 'notLoaded') return 'notLoaded · 返回状态与加载记录不一致，需刷新核对';
      return `unknown · 当前状态未确认${type ? `（返回 ${safe(type, 100)}）` : ''}`;
    }
    if (type === 'notLoaded') return 'notLoaded · 返回未加载状态';
    return `unknown · 非当前运行状态${type ? `（记录状态 ${safe(type, 100)}）` : ''}`;
  }
  function merge(previous, incoming) {
    if (!previous) return incoming;
    const result = { ...previous, ...incoming };
    result.discoverySources = [...new Set([...(Array.isArray(previous.discoverySources) ? previous.discoverySources : []), ...(Array.isArray(incoming.discoverySources) ? incoming.discoverySources : [])])];
    // A later stored-only page must not replace explicit runtime information from
    // an earlier loaded page. All labels remain observations from this refresh.
    if (previous.loaded === true && incoming.loaded !== true) {
      result.loaded = true; result.status = previous.status;
      result.canAcceptDirectInput = previous.canAcceptDirectInput;
    }
    if (previous.binding && !incoming.binding) result.binding = previous.binding;
    if (previous.connectorSessionId && !incoming.connectorSessionId) result.connectorSessionId = previous.connectorSessionId;
    return result;
  }
  function render() {
    const fragment = document.createDocumentFragment();
    for (const item of entries.values()) {
      const card = element('article', 'card setup-section'); card.dataset.threadId = item.id;
      const heading = element('div', 'section-heading'), title = element('div');
      title.append(element('h2', '', safe(item.name || '未命名会话', 160)), element('p', '', loadedLabel(item)));
      const type = typeof item.status === 'string' ? item.status : item.status?.type;
      const tone = item.loaded === true && type === 'active' ? 'good' : item.loaded === true ? 'neutral' : 'warning';
      heading.append(title, element('span', `badge ${tone}`, statusLabel(item))); card.append(heading);
      const list = element('dl', 'detail-list');
      row(list, 'Thread ID', item.id); row(list, '工作目录', item.cwd);
      row(list, '来源', item.source === undefined ? '未提供' : safe(item.source));
      row(list, '发现来源', Array.isArray(item.discoverySources) && item.discoverySources.length ? item.discoverySources.map(v => safe(v, 100)).join(' / ') : '未提供');
      row(list, '模型', item.model); if (item.reasoningEffort) row(list, '推理强度', item.reasoningEffort);
      row(list, '可管理情况', item.manageable === true ? '可管理（此页面仅展示，不执行控制）' : item.manageable === false ? '不可管理' : '未确认');
      if (item.reason) row(list, '限制原因', item.reason);
      row(list, '直接输入能力', item.canAcceptDirectInput === true ? '接口报告支持' : item.canAcceptDirectInput === false ? '接口报告不支持' : '未确认');
      row(list, 'Slack 绑定', item.binding ? `${safe(item.binding.channel, 100) || '频道未提供'} · thread ${safe(item.binding.threadTs, 100) || '未提供'}` : item.connectorSessionId ? '已有 connector 映射，目标 thread 信息未提供' : '未绑定');
      if (item.connectorSessionId) row(list, 'Connector 会话 ID', item.connectorSessionId);
      card.append(list); fragment.append(card);
    }
    $('sessions-list').replaceChildren(fragment);
    $('sessions-page-count').textContent = `${entries.size} 条`;
    $('sessions-summary').textContent = entries.size ? `已发现 ${entries.size} 个唯一会话` : pages ? '本轮未发现可见会话' : '尚未读取会话';
    $('sessions-pagination').textContent = pages ? `已读取 ${pages} 页${lastRead ? ` · ${lastRead}` : ''}。${paginationError ? '分页异常，结果可能不完整。' : nextCursor ? '仍有下一页，当前列表不是全部结果。' : '本轮分页已结束；这不保证独立进程或不受支持的会话可见。'}` : '请先启动本应用的连接器，再点击刷新。不会在打开页面时自动请求。';
    $('sessions-more').hidden = !nextCursor;
    $('sessions-more').disabled = reading;
    $('sessions-refresh').disabled = reading;
    $('sessions-refresh').textContent = reading ? '正在读取…' : '刷新列表';
    $('sessions-more-note').textContent = nextCursor ? '每次点击只读取下一页；结果会按 thread ID 去重。' : '';
  }
  async function readPage(reset) {
    if (reading || disposed) return;
    const requestedCursor = reset ? null : nextCursor;
    if (!reset && !requestedCursor) return;
    reading = true; render();
    $('sessions-feedback').textContent = reset ? '正在只读刷新会话元数据；不会恢复、创建或绑定会话。' : '正在读取下一页，已有记录会保留。';
    try {
      if (!window.connector || typeof window.connector.listSessions !== 'function') throw new Error('桌面会话接口不可用，请使用包含会话列表功能的桌面版本。');
      const response = await window.connector.listSessions({ limit: 50, ...(requestedCursor ? { cursor: requestedCursor } : {}) });
      if (disposed) return;
      if (!response?.ok) throw new Error(safe(response?.error?.message || '会话读取失败。请检查连接概览中的本地服务和共享 Codex 状态。'));
      const page = response.value;
      if (!page || !Array.isArray(page.sessions) || page.sessions.length > 200 || !(page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 2048))) throw new Error('会话列表格式无法识别；没有加载会话内容，请检查接口版本。');
      if (page.sessions.some(item => !item || typeof item.id !== 'string' || !item.id || item.id.length > 512)) throw new Error('会话列表缺少有效 thread ID，未应用本页。');
      if (reset) { entries.clear(); pages = 0; seenCursors.clear(); paginationError = false; }
      for (const item of page.sessions) entries.set(item.id, merge(entries.get(item.id), item));
      pages++; lastRead = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const repeated = page.nextCursor !== null && (page.nextCursor === requestedCursor || seenCursors.has(page.nextCursor));
      if (requestedCursor) seenCursors.add(requestedCursor);
      nextCursor = repeated ? null : page.nextCursor; paginationError = repeated;
      $('sessions-feedback').textContent = repeated ? '后端返回了重复的分页游标，已停止继续读取以免循环；当前列表可能不完整，请刷新或检查接口兼容性。' : '只读元数据已更新。运行状态反映读取时的观察，不是持续实时监控。';
      $('sessions-scope').textContent = page.scope ? `接口范围：${safe(page.scope)}` : '范围由当前共享服务和本机配置决定。';
      render();
      if (repeated) $('sessions-pagination').textContent = `已读取 ${pages} 页；分页异常，结果可能不完整。`;
    } catch (error) {
      $('sessions-feedback').textContent = safe(error?.message || '会话读取失败，请检查连接状态后重试。');
      if (pages) $('sessions-pagination').textContent = `保留之前读取的 ${entries.size} 条记录；本次读取未成功，不能认为这些状态仍是最新。`;
    } finally {
      reading = false;
      $('sessions-refresh').disabled = false; $('sessions-refresh').textContent = '刷新列表';
      $('sessions-more').disabled = false;
    }
  }
  $('sessions-refresh').addEventListener('click', () => { void readPage(true); });
  $('sessions-more').addEventListener('click', () => { void readPage(false); });
  window.addEventListener('pagehide', () => { disposed = true; });
  render();
})();
