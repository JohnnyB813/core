import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,head,hash} from './helpers.ts';
import {workerReadPath,workerApi} from '../runtime/worker-api.ts';
import {cgroupResources} from '../runtime/resources.ts';

test('worker TLS adapter permits only the fixed read paths',()=>{
  for(const path of ['/chain/head','/chain/block/1/hash','/chain/block/4294967295/header','/peers/connected/connection'])assert(workerReadPath(path));
  for(const path of ['/','/chain/head?x=1','/chain/head/','/chain/block/0/hash','/chain/block/01/hash','/chain/block/4294967296/hash','/chain/block/1/%68ash','/chain/block/1/../hash','/wallet','/settings','/pilot/control','http://other/chain/head'])assert.equal(workerReadPath(path),false,path);
  assert.throws(()=>workerApi(3000));assert.throws(()=>workerApi(0));
});
test('worker read adapter forwards to fixed loopback only and never forwards headers or writes',async()=>{
  const requests:{path:string;method:string;authorization:unknown}[]=[];
  const upstream=await fixture((req,res)=>{requests.push({path:req.url!,method:req.method!,authorization:req.headers.authorization});res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/chain/head'?head:{code:0,data:{hash}}));});
  const adapter=workerApi(Number(new URL(upstream.url).port));
  const front=await fixture((req,res)=>{void adapter(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
  try{
    const response=await fetch(front.url+'/chain/head',{headers:{authorization:'Bearer ignored'}});assert.equal(response.status,200);assert.deepEqual(await response.json(),head);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal((await fetch(front.url+'/chain/block/1/hash')).status,200);
    assert.equal((await fetch(front.url+'/wallet')).status,404);
    assert.equal((await fetch(front.url+'/chain/head?target=http://other')).status,404);
    assert.equal((await fetch(front.url+'/chain/head',{method:'POST',body:'{}'})).status,404);
    assert.deepEqual(requests,[{path:'/chain/head',method:'GET',authorization:undefined},{path:'/chain/block/1/hash',method:'GET',authorization:undefined}]);
  }finally{await front.close();await upstream.close();}
});
test('worker read adapter rejects malformed upstream health and bounds stalled responses',async()=>{
  const upstream=await fixture((req,res)=>{if(req.url==='/chain/head')res.end('{"code":0,"data":{"height":0,"synced":true}}');});
  const adapter=workerApi(Number(new URL(upstream.url).port)),front=await fixture((req,res)=>{void adapter(req,res);});
  try{
    assert.equal((await fetch(front.url+'/chain/head')).status,502);
    const began=Date.now();assert.equal((await fetch(front.url+'/chain/block/1/hash')).status,502);assert(Date.now()-began<2200);
  }finally{await front.close();await upstream.close();}
});
const reader=(values:Record<string,string>)=>async(path:string)=>values[path]??null;
test('resource observations distinguish enforced cgroup v2 limits from unlimited values',async()=>{
  const limited=await cgroupResources(reader({'/sys/fs/cgroup/memory.max':'536870912','/sys/fs/cgroup/memory.current':'100','/sys/fs/cgroup/memory.peak':'200','/sys/fs/cgroup/cpu.max':'200000 100000'}));
  assert.equal(limited.memoryLimitBytes,536870912);assert.equal(limited.cpuCores,2);assert.equal(limited.memoryLimitKind,'limited');assert.equal(limited.memoryCurrentBytes,100);
  const unlimited=await cgroupResources(reader({'/sys/fs/cgroup/memory.max':'max','/sys/fs/cgroup/cpu.max':'max 100000'}));assert.equal(unlimited.memoryLimitBytes,null);assert.equal(unlimited.memoryLimitKind,'unlimited');assert.equal(unlimited.cpuLimitKind,'unlimited');
});
test('resource observations support cgroup v1 and preserve unavailable limits',async()=>{
  const v1=await cgroupResources(reader({'/sys/fs/cgroup/memory/memory.limit_in_bytes':'104857600','/sys/fs/cgroup/memory/memory.usage_in_bytes':'1000','/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us':'50000','/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us':'100000'}));assert.equal(v1.memoryLimitBytes,104857600);assert.equal(v1.memoryCurrentBytes,1000);assert.equal(v1.cpuCores,0.5);
  const uncapped=await cgroupResources(reader({'/sys/fs/cgroup/memory/memory.limit_in_bytes':'9223372036854771712','/sys/fs/cgroup/cpu/cpu.cfs_quota_us':'-1'}));assert.equal(uncapped.memoryLimitKind,'unlimited');assert.equal(uncapped.cpuLimitKind,'unlimited');
  const missing=await cgroupResources(reader({}));assert.equal(missing.memoryLimitKind,'unavailable');assert.equal(missing.cpuLimitKind,'unavailable');
});
