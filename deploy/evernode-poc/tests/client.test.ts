import test from 'node:test';
import assert from 'node:assert/strict';
import {readFromGateways} from '../client/failover.ts';
import {fixture,head} from './helpers.ts';
test('one failed gateway falls back once to the second',async t=>{
  let a=0,b=0;const first=await fixture((_q,r)=>{a++;r.writeHead(503);r.end('{}');});t.after(first.close);
  const second=await fixture((_q,r)=>{b++;r.end(JSON.stringify(head));});t.after(second.close);
  const result=await readFromGateways([first.url,second.url],'/chain/head',500);
  assert.equal(result.gateway,second.url);assert.equal(a,1);assert.equal(b,1);
});
test('hung gateway uses bounded fallback',async t=>{
  const first=await fixture(()=>{});t.after(first.close);const second=await fixture((_q,r)=>r.end(JSON.stringify(head)));t.after(second.close);
  const began=performance.now();assert.equal((await readFromGateways([first.url,second.url],'/chain/head',100)).gateway,second.url);assert(performance.now()-began<1000);
});
test('two-attempt budget excludes additional gateways',async t=>{
  let firstCalls=0,secondCalls=0,thirdCalls=0;const a=await fixture((_q,r)=>{firstCalls++;r.writeHead(503);r.end('{}');});t.after(a.close);
  const b=await fixture((_q,r)=>{secondCalls++;r.writeHead(503);r.end('{}');});t.after(b.close);
  const c=await fixture((_q,r)=>{thirdCalls++;r.end(JSON.stringify(head));});t.after(c.close);
  await assert.rejects(readFromGateways([a.url,b.url,c.url],'/chain/head',100));assert.equal(firstCalls,1);assert.equal(secondCalls,1);assert.equal(thirdCalls,0);
});
test('malformed success is treated as failed gateway',async t=>{
  const a=await fixture((_q,r)=>r.end('{"code":0,"data":{}}'));t.after(a.close);
  const b=await fixture((_q,r)=>r.end(JSON.stringify(head)));t.after(b.close);
  assert.equal((await readFromGateways([a.url,b.url],'/chain/head',500)).gateway,b.url);
});
test('public client rejects remote HTTP and non-read routes',async()=>{
  await assert.rejects(readFromGateways(['http://example.com'],'/chain/head'),/HTTPS/);
  await assert.rejects(readFromGateways(['https://example.com'],'/chain/append'),/not allowed/);
});
