import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Store } from '../src/store.js';
import { deliveryStatus } from '../src/session-delivery.js';
import { fixture, ready, request, run } from './helpers.js';

test('integrated capabilities advertise independent delivery evidence and opt-in screenshot controls',async()=>{
  const f=fixture();try{
    await f.connector.initialize();
    let capabilities=f.connector.capabilities();
    assert.equal(capabilities.sessionDelivery.command,'session.delivery');
    assert.equal(capabilities.sessionDelivery.automaticRetry,false);
    assert.equal(capabilities.screenCapture.enabled,false);
    assert.equal(capabilities.screenCapture.oneShot,true);
    f.config.screenPolicy={enabled:true};capabilities=f.connector.capabilities();
    assert.equal(capabilities.screenCapture.enabled,true);
    assert.equal(capabilities.screenCapture.desktopAvailable,false);
    assert.equal(capabilities.sessionDelivery.completion,'matched terminal turn only');
  }finally{await f.cleanup();}
});

test('restart both preserves uncertain message evidence and expires queued screenshots without replay',async()=>{
  const f=fixture(),s=await ready(f),w=await run(f,'session.send',{sessionId:s.id,text:'once'});
  await f.connector.close();
  f.store.transaction(state=>{
    const send=state.work.find(row=>row.id===w.id)!;send.status='executing';send.messageDelivery!.start='pending';
    state.work.push({id:'capture-work',eventId:'capture-event',request:request('screen.capture',{displayId:'all'}),source:{kind:'bot',userId:'UDOT',channel:'CIN',threadTs:'90.1',ts:'90.1',eventId:'capture-event'},status:'queued',createdAt:new Date().toISOString()});
  });
  f.store.close();const reloaded=new Store(f.dir);
  try{
    const send=reloaded.state.work.find(row=>row.id===w.id)!;
    assert.equal(send.status,'uncertain');assert.equal(send.messageDelivery?.start,'uncertain');
    assert.equal(send.messageDelivery?.observationGap,true);assert.equal(deliveryStatus(send),'processing');
    const capture=reloaded.state.work.find(row=>row.id==='capture-work')!;
    assert.equal(capture.status,'failed');assert.equal(capture.error,'SCREEN_REQUEST_EXPIRED');
  }finally{reloaded.close();rmSync(f.dir,{recursive:true,force:true});}
});
