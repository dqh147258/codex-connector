// An explicit, one-shot, read-only handshake diagnostic. Never construct the
// Connector runtime: no store, background reconnect, HTTP listener or Slack.
import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const help = 'Usage: node scripts/verify-default-owner.mjs --codex-exe ABSOLUTE_PATH_TO_OFFICIAL_CODEX\n       node scripts/verify-default-owner.mjs --offline-fixture\n';
const emit = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const failureCodes = new Set(['BACKEND_STOPPED','SHARED_DAEMON_UNAVAILABLE','VERSION_MISMATCH','PROXY_TRANSPORT_FAILED','PROXY_DISCONNECTED','PROXY_START_FAILED','PROXY_WRITE_FAILED','INVALID_PROTOCOL','RPC_REJECTED','RPC_OUTCOME_UNCERTAIN','BACKEND_UNAVAILABLE','METHOD_UNSUPPORTED','PROXY_CLOSE_UNCONFIRMED']);
const failureStages = new Set(['version-probe','version-check','daemon-start','proxy-launch','websocket-upgrade','initialize','home-verification','initialized','connected']);
function snapshot(backend) {
  const caps = backend.capabilities(), obs = backend.observation;
  return {
    health: backend.connected ? 'online' : obs.checkedAt ? 'unavailable' : 'unknown',
    connected: backend.connected, checkedAt: obs.checkedAt,
    // Backend observation filters untrusted version-command stdout. The native
    // server may differ from this executable; do not parse/print raw userAgent.
    executableVersion: obs.version, serverVersion: null, homeVerified: false,
    lastFailure: caps.lastFailure ? failureCodes.has(caps.lastFailure) ? caps.lastFailure : 'OTHER_FAILURE' : null,
    lastFailureStage: failureStages.has(caps.lastFailureStage) ? caps.lastFailureStage : null,
    daemonStartAttempted: caps.daemonStart.attempted === true
  };
}
function officialName(value) {
  if (!value || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) return false;
  // A Windows rooted-relative/UNC/device path is not a pinned local drive path.
  if(process.platform==='win32') return /^[A-Za-z]:[\\/]/.test(value) && basename(value).toLowerCase()==='codex.exe';
  return !value.startsWith('//') && basename(value)==='codex';
}
async function main() {
  const args=process.argv.slice(2);
  if(args.length===1 && args[0]==='--help'){process.stdout.write(help);return;}
  const offline=args.length===1 && args[0]==='--offline-fixture';
  if(!offline && !(args.length===2 && args[0]==='--codex-exe' && officialName(args[1]))) {
    process.stderr.write(help);process.exitCode=2;return;
  }
  let SharedAppServer;
  try { ({SharedAppServer}=await import('../dist/src/codex.js')); }
  catch { emit({ok:false,stage:'load-candidate',error:'COMPILED_CONNECTOR_OR_RUNTIME_DEPENDENCY_UNAVAILABLE'});process.exitCode=2;return; }
  if(offline) {
    // The bundled protocol fixture has a tracing switch for automated tests.
    // Never inherit its logging destination, fake version/home or fault switches.
    for(const k of Object.keys(process.env))if(/^CONNECTOR_FIXTURE_/i.test(k))delete process.env[k];
  }
  const executable=offline?fileURLToPath(new URL('../test/fixtures/app-server.cjs',import.meta.url)):args[1];
  const backend=new SharedAppServer({executable,autoStartDaemon:false},10000); // intentionally no --sock or codexHome override
  const report={
    mode:offline?'offline-synthetic-fixture':'default-owner-proxy',
    platform:process.platform, nodeVersion:process.versions.node,
    homeSelection:process.env.CODEX_HOME?'inherits-CODEX_HOME':'uses-native-default',
    serverId:'default',cachedBefore:snapshot(backend),cachedAfter:null,
    probePassed:false,cleanup:'not-yet-requested',ok:false
  };
  let stopping=false,closeTask;
  const close=()=>closeTask??=(async()=>{
    try {await backend.close();return 'close-returned';}
    catch {return 'proxy-close-unconfirmed';}
  })();
  const stop=()=>{stopping=true;void close();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    try{await backend.connect();}catch{/* expose only allowlisted diagnostics below */}
    report.cachedAfter=snapshot(backend); // actual probe state, BEFORE intentional close
    report.probePassed=!stopping && report.cachedAfter.connected && !report.cachedAfter.daemonStartAttempted;
  }finally{
    report.cleanup=await close();
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  }
  report.ok=report.probePassed && report.cleanup==='close-returned' && !stopping;
  emit(report);if(!report.ok)process.exitCode=stopping?130:1;
}
main().catch(()=>{emit({ok:false,stage:'diagnostic',error:'PROBE_FAILED'});process.exitCode=1;});
