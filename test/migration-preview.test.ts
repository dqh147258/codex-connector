import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrationPreview } from '../src/migration-preview.js';
const old={version:2,sessions:[{id:'PRIVATE_HANDLE'}],work:[{status:'queued',request:{secret:'PRIVATE_MESSAGE'}},{status:'executing'},{status:'completed'}],
  outbox:[{status:'queued',text:'DO_NOT_SHOW'},{status:'sending'}],pending:[{status:'responding'}],seenEvents:{},seenNotifications:{},subscriptions:[{}]};
const digest=(dir:string,file:string)=>createHash('sha256').update(readFileSync(join(dir,file))).digest('hex');
test('migration-preview reads only old root ledger and config registry shape, even while locked, and reveals counts only',()=>{
  const dir=mkdtempSync(join(tmpdir(),'migration-preview-'));
  try{
    const absent=join(dir,'never-created');
    assert.equal(migrationPreview(absent).state,'absent');assert.equal(existsSync(absent),false);
    const path=join(dir,'state.json'),cfg=join(dir,'config.json');
    writeFileSync(path,JSON.stringify(old));
    writeFileSync(cfg,JSON.stringify({version:2,backend:{executable:'/nonexistent/executable'},projects:{notTouched:'/unavailable/project'}}));
    writeFileSync(join(dir,'runtime.lock'),'non-owned-lock');writeFileSync(join(dir,'daemon.lock'),'non-owned-lock');
    const files=readdirSync(dir).sort(),before=digest(dir,'state.json'),configHash=digest(dir,'config.json');
    const preview=migrationPreview(dir);
    assert.equal(preview.state,'legacy-single-default');assert.equal(preview.ambiguous,false);assert.equal(preview.validatesPhysicalTarget,false);
    assert.deepEqual(preview.legacyRows,{sessions:1,work:3,outbox:2,pending:1,subscriptions:1,activity:0,results:0});
    assert.deepEqual(preview.quarantine,{entireLegacyLedger:false,workMarkedUncertain:2,outboxMarkedUncertain:2,requestsMarkedStale:1});
    const output=execFileSync(process.execPath,[resolve('dist/src/cli.js'),'migration-preview','--home',dir],{encoding:'utf8'});
    assert.deepEqual(JSON.parse(output),preview);assert.doesNotMatch(output,/PRIVATE|DO_NOT_SHOW|nonexistent|unavailable|non-owned/);
    assert.deepEqual(readdirSync(dir).sort(),files);assert.equal(digest(dir,'state.json'),before);assert.equal(digest(dir,'config.json'),configHash);
    for(const reg of [{backends:{only:{executable:'/unused'}}},{backend:{executable:'/unused'},backends:{other:{executable:'/unused',socketPath:'/unread'}}}]){
      writeFileSync(cfg,JSON.stringify({version:2,...reg}));const blocked=migrationPreview(dir);
      assert.equal(blocked.ambiguous,true);assert.equal(blocked.state,'legacy-blocked');assert.deepEqual(blocked.quarantine,{entireLegacyLedger:true});
      assert.equal(digest(dir,'state.json'),before);assert.deepEqual(readdirSync(dir).sort(),files);
    }
    writeFileSync(path,JSON.stringify({...old,targetPin:{id:'default',fingerprint:'a'.repeat(64)}}));
    assert.equal(migrationPreview(dir).state,'already-pinned');
    writeFileSync(path,'{"private malformed input"');assert.throws(()=>migrationPreview(dir),/^Error: MIGRATION_PREVIEW_UNAVAILABLE/);
    rmSync(path);symlinkSync(cfg,path);assert.throws(()=>migrationPreview(dir),/MIGRATION_PREVIEW_UNAVAILABLE/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
