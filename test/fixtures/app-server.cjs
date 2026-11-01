// Pure local protocol fixture. This is NOT Codex and never makes network requests.
const { createInterface } = require('node:readline');
const reply = value => process.stdout.write(JSON.stringify(value) + '\n');
let threadSandbox;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.jsonrpc) process.exit(12);
  if (m.method === 'initialize') {
    if (process.env.SLACK_APP_TOKEN || process.env.SLACK_BOT_TOKEN || process.env.CONNECTOR_TOKEN) process.exit(13);
    reply({ id: m.id, result: { userAgent: 'fake' } });
  } else if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (m.params.approvalPolicy !== undefined || !['readOnly', 'workspaceWrite', undefined].includes(m.params.sandbox)) process.exit(14);
    threadSandbox = m.params.sandbox;
    reply({ id: m.id, result: { thread: { id: m.params.threadId || 'test-thread' } } });
  } else if (m.method === 'turn/start') {
    const threadId = m.params.threadId, turnId = 'turn-1', text = m.params.input[0].text;
    if (m.params.approvalPolicy !== undefined) process.exit(15);
    if (text.includes('[inherit]') && (threadSandbox !== undefined || m.params.sandboxPolicy !== undefined || m.params.approvalPolicy !== undefined)) process.exit(17);
    reply({ id: m.id, result: { turn: { id: turnId } } });
    if (text.includes('[exit]')) return process.exit(2);
    if (text.includes('[approval]')) return reply({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId, turnId } });
    if (text.includes('[unknown-request]')) return reply({ id: 'input-1', method: 'item/tool/requestUserInput', params: { threadId, turnId } });
    reply({ method: 'item/completed', params: { threadId, turnId, item: { id: 'reason', type: 'reasoning', text: 'PRIVATE REASONING' } } });
    reply({ method: 'item/completed', params: { threadId, turnId, item: { id: 'comment', type: 'agentMessage', phase: 'commentary', text: 'not final' } } });
    reply({ method: 'item/completed', params: { threadId, turnId, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'safe final answer' } } });
    reply({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: text.includes('[failed]') ? 'failed' : 'completed' } } });
  } else if (m.method === 'turn/interrupt') reply({ id: m.id, result: {} });
  else if (m.id === 'approval-1' && m.result?.decision !== 'decline') process.exit(16);
});
