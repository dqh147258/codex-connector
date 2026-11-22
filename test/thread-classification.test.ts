import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyNativeThread,nativeRootError } from '../src/thread-classification.js';

const id='b53c9272-13d6-711d-8a7d-36290cd9906b';
const parent='a87c1ccc-44c3-7888-892c-f3c94330a810';
const row=(source:unknown,more:Record<string,unknown>={})=>({id,sessionId:id,parentThreadId:null,source,...more});

test('official v0.171.0-alpha.13 wire roots, forks and qualified App Server roots',()=>{
  for(const source of ['cli','vscode',{custom:'atlas'},{custom:'chatgpt'},'appServer']){
    assert.equal(classifyNativeThread(row(source)),'root');
    assert.equal(classifyNativeThread(row(source,{forkedFromId:parent})),'root');
  }
  assert.equal(classifyNativeThread(row('appServer',{sessionId:parent})),'unknown');
  assert.equal(classifyNativeThread(row('cli',{attachedToThreadId:parent})),'unknown');
  assert.equal(classifyNativeThread(row('cli',{threadSource:'guardian_review'})),'unknown');
});

test('explicit child evidence wins even against a root-looking source or ordinary title',()=>{
  for(const sub of ['review','compact','memory_consolidation',{thread_spawn:{parent_thread_id:parent,depth:1}},
    {other:'workflow helper'}])assert.equal(classifyNativeThread(row({subAgent:sub},{name:'Normal project'})),'child');
  assert.equal(classifyNativeThread(row('cli',{parentThreadId:parent,canAcceptDirectInput:true})),'child');
  assert.equal(classifyNativeThread(row({custom:'chatgpt'},{threadSource:'subagent',name:'Main conversation'})),'child');
  assert.equal(nativeRootError('child'),'SUBAGENT_THREAD_NOT_SUPPORTED');
});

test('unknown lineage is not inferred from title, nickname, project, status or ability to take input',()=>{
  for(const source of [undefined,null,'unknown','exec','atlas','mcp',{custom:'other'},['cli'],{custom:'atlas',other:true}]){
    assert.equal(classifyNativeThread(row(source,{name:'Review task',canAcceptDirectInput:true,status:{type:'active'}})),'unknown');
  }
  assert.equal(classifyNativeThread({id,source:'cli'}),'unknown');
  assert.equal(classifyNativeThread(row('cli',{parentThreadId:' '})),'unknown');
  assert.equal(classifyNativeThread(row('cli',{parentThreadId:parent+'\n'})),'unknown');
  assert.equal(classifyNativeThread(row('cli',{id:id+'\n'})),'unknown');
  assert.equal(nativeRootError('unknown'),'NATIVE_THREAD_ROOT_UNVERIFIED');
});

test('only caller-proven, exact fresh thread/start identity may substitute for unknown source',()=>{
  const native=row('unknown',{forkedFromId:null,ephemeral:false});
  assert.equal(classifyNativeThread(native),'unknown');
  assert.equal(classifyNativeThread(native,{acknowledgedThreadId:id}),'root');
  assert.equal(classifyNativeThread(native,{acknowledgedThreadId:parent}),'unknown');
  assert.equal(classifyNativeThread({...native,source:{subAgent:'review'}},{acknowledgedThreadId:id}),'child');
  assert.equal(classifyNativeThread({...native,ephemeral:true},{acknowledgedThreadId:id}),'unknown');
});
