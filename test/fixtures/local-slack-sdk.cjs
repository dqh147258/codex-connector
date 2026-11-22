// Test-process preload only. Do not connect to Slack, open a socket, or send a message.
// The actual CLI, persistent store, HTTP listener and child proxy lifecycle are used.
const { WebClient } = require('@slack/web-api');
const { SocketModeClient } = require('@slack/socket-mode');
const { appendFileSync } = require('node:fs');
const log = (value) => appendFileSync(process.env.CONNECTOR_FIXTURE_SLACK_LOG, JSON.stringify(value)+'\n');
WebClient.prototype.apiCall = async function(method) {
  log(method);
  if (method === 'auth.test') return {ok:true,team_id:process.env.CONNECTOR_FIXTURE_SLACK_TEAM,user_id:'USELF',bot_id:'BSELF'};
  if (method === 'users.info') return {ok:true,user:{id:'UDOT',name:'dot',profile:{display_name:'dot'}}};
  throw Error('Unexpected fixture Web API call');
};
SocketModeClient.prototype.start = async function() { log('socket.start'); this.emit('connected'); return {}; };
SocketModeClient.prototype.disconnect = async function() { log('socket.disconnect'); this.emit('disconnected'); };
