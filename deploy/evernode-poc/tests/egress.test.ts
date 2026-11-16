import test from 'node:test';
import assert from 'node:assert/strict';
import {EgressObservation} from '../runtime/egress.ts';
test('egress measurement uses one fixed HTTPS source and caches a valid IPv4 observation',async()=>{
  let calls=0;const value=new EgressObservation();const fetcher=async(url:string,init:RequestInit)=>{calls++;assert.equal(url,'https://api.ipify.org?format=json');assert.equal(init.redirect,'error');return new Response('{"ip":"203.0.113.25"}');};
  await value.check(fetcher,()=>100);await value.check(fetcher,()=>200);assert.equal(calls,1);assert.deepEqual(value.current(),{status:'observed',ip:'203.0.113.25',checkedAt:100,source:'https://api.ipify.org'});
});
test('egress failures never invent an IP or retry without a bound',async()=>{
  for(const body of ['{"ip":"not-an-ip"}','{"ip":"203.0.113.25","redirect":"https://other"}','x'.repeat(1025)]){const value=new EgressObservation();await value.check(async()=>new Response(body),()=>100);assert.equal(value.current().status,'unavailable');assert.equal(value.current().ip,null);}
  let calls=0;const value=new EgressObservation(),fetcher=async()=>{calls++;throw new Error('offline');};for(let i=0;i<10;i++)await value.check(fetcher);assert.equal(calls,3);value.stop();await value.check(fetcher);assert.equal(calls,3);
});
