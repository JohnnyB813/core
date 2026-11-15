import test from 'node:test';
import assert from 'node:assert/strict';
import {probePool} from '../shared/pool-probe.ts';
import {fixture,hash} from './helpers.ts';
import type {Policy} from '../shared/health.ts';
const policy:Policy={checkpoint:{height:5000000,hash},minimumHeight:5000000,maxLag:3,minPeers:2,maxLatencyMs:3000,freshnessMs:30000};
async function workers(t:{after:(fn:()=>Promise<void>)=>void},mode='normal'){
  const servers=await Promise.all([0,1,2].map(index=>fixture((req,res)=>{
    if(mode==='offline'&&index===2)return;
    const tip=mode==='ahead'&&index===2?5000200:5000100;
    const data=req.url==='/chain/head'?{height:tip,hash,synced:true}:req.url==='/peers/connected/connection'?{connections:[{},{}]}:{hash:req.url==='/chain/block/5000000/hash'?hash:(mode==='conflict'&&index===2?'c':'b').repeat(64)};
    res.end(JSON.stringify({code:0,data}));
  })));
  for(const server of servers)t.after(server.close);
  return servers.map((server,index)=>({id:'w'+(index+1),url:server.url}));
}
test('three matching workers need no outside reference',async t=>{const endpoints=await workers(t);const result=await probePool(endpoints,policy,5000080,500);assert([...result.values()].every(s=>s.assessment.healthy));assert.equal(result.get('w1')!.observation!.common!.height,5000080);});
test('an offline worker does not consume the healthy workers latency budget',async t=>{const endpoints=await workers(t,'offline');const result=await probePool(endpoints,policy,5000080,500);assert.equal(result.get('w1')!.assessment.healthy,true);assert.equal(result.get('w2')!.assessment.healthy,true);assert.equal(result.get('w3')!.assessment.healthy,false);});
test('conflicting fresh hash is excluded',async t=>{const endpoints=await workers(t,'conflict');const result=await probePool(endpoints,policy,5000080,500);assert.equal(result.get('w1')!.assessment.healthy,true);assert.equal(result.get('w2')!.assessment.healthy,true);assert.equal(result.get('w3')!.assessment.healthy,false);});
test('unsupported far-ahead tip does not become the reference',async t=>{const endpoints=await workers(t,'ahead');const result=await probePool(endpoints,policy,5000080,500);assert.equal(result.get('w1')!.assessment.healthy,true);assert.equal(result.get('w2')!.assessment.healthy,true);assert.equal(result.get('w3')!.assessment.healthy,false);});
