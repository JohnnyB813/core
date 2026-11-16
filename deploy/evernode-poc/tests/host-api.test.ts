import test from 'node:test';
import assert from 'node:assert/strict';
import {EvrPanelClient} from '../deploy/evrpanel.ts';
import type {HostTarget,RestartJournal,RestartPlan,RestartReceipt} from '../deploy/evrpanel.ts';
import {FileRestartJournal} from '../deploy/restart-journal.ts';
import {mkdtemp,appendFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';

const now=2_000_000_000_000;
const target:HostTarget={origin:'https://host.example',account:'r'+'a'.repeat(25),lease:'A'.repeat(64),slot:2,userPort:30222,image:'example/pilot:tested',imageDigest:'sha256:'+'b'.repeat(64)};
function row(){return{tenant:target.account,name:target.lease,user_port:30222,peer_port:30212,gp_tcp_port:30233,image:target.image,imageDigest:'@'+target.imageDigest,status:'active',expiry_timestamp:now/1000+3600};}
class Journal implements RestartJournal {
  plan:RestartPlan|null=null;claimed=false;receipts:RestartReceipt[]=[];
  async create(plan:RestartPlan){if(this.plan)throw new Error('duplicate');this.plan=structuredClone(plan);}
  async get(){if(!this.plan)throw new Error('missing');return structuredClone(this.plan);}
  async claim(){if(this.claimed)return false;this.claimed=true;return true;}
  async record(receipt:RestartReceipt){this.receipts.push(receipt);}
  async latest(){return this.receipts.at(-1)||null;}
}
function fixture(options:{changed?:Partial<ReturnType<typeof row>>;failRestart?:boolean;logs?:string;list?:unknown}={}){
  let restarts=0;const requests:{url:string;body:Record<string,unknown>|null}[]=[];
  const fetcher=async(input:string|URL,init?:RequestInit)=>{
    const url=String(input),body=init?.body?JSON.parse(String(init.body)):null;
    requests.push({url,body});assert.equal(init?.redirect,'error');assert.ok(init?.signal);
    if(url.endsWith('/api-sashilist'))return Response.json(options.list??{sashiList:[{...row(),...options.changed}]});
    if(body?.type==='docker_logs')return Response.json({data:options.logs||''});
    if(body?.type==='restart'){restarts++;if(options.failRestart)throw new Error('lost response with sensitive cookie=fixture');return Response.json({success:true});}
    throw new Error('Unexpected route');
  };
  return{client:new EvrPanelClient(target,'session=fixture',fetcher,()=>now),requests,restarts:()=>restarts};
}
test('host API projects only the named owned lease and never returns session or private fields',async()=>{
  const f=fixture({list:{sashiList:[{...row(),instancePrivateKeys:'private-value',Env:['TOKEN=secret-value']}]}});
  const observation=await f.client.observe();assert.equal(observation.lease,target.lease);assert.equal(observation.peerPort,30212);
  assert.doesNotMatch(JSON.stringify(observation),/fixture|private-value|secret-value|instancePrivateKeys|Env/);
});
test('wrong tenant, changed lease, changed image and expired leases cannot be restarted',async()=>{
  for(const changed of [{tenant:'another-tenant'},{name:'C'.repeat(64)},{image:'example/changed:latest'},{imageDigest:'sha256:'+'c'.repeat(64)},{expiry_timestamp:now/1000-1},{status:'inactive'}]){
    const f=fixture({changed});await assert.rejects(f.client.prepareRestart(new Journal(),'restart-fixture-1'));assert.equal(f.restarts(),0);
  }
});
test('missing or duplicate physical slot metadata cannot select another instance',async()=>{
  for(const list of [{sashiList:[{...row(),user_port:30223}]},{sashiList:[row(),row()]}])await assert.rejects(fixture({list}).client.observe());
});
test('diagnostics retain only safe startup evidence and discard private instance material',async()=>{
  const logs=['2033-05-18T03:33:20.000Z | {"event":"gateway-tls-bootstrap","uid":1000}',
    'privateKey=private-value P2P endpoint is x', 'authorization=bearer-value Warthog Node',
    '2033-05-18T03:33:21.000Z | P2P advertised port is 30212.'].join('\n');
  const d=await fixture({logs}).client.diagnostics();assert.equal(d.lines.length,2);assert.equal(d.startupTimes.length,1);assert.doesNotMatch(JSON.stringify(d),/private-value|bearer-value/);
});
test('restart is durably claimed once before submission and a lost response cannot be replayed',async()=>{
  const f=fixture({failRestart:true}),journal=new Journal();await f.client.prepareRestart(journal,'restart-fixture-1');
  const result=await f.client.restartOnce(journal,'restart-fixture-1');assert.equal(result.state,'uncertain');assert.equal(journal.receipts[0].state,'uncertain');assert.equal(f.restarts(),1);
  await assert.rejects(f.client.restartOnce(journal,'restart-fixture-1'),/already claimed/);assert.equal(f.restarts(),1);
});
test('successful restart acknowledgment is submitted until a new startup is observed',async()=>{
  const f=fixture(),journal=new Journal();await f.client.prepareRestart(journal,'restart-fixture-1');
  assert.equal((await f.client.restartOnce(journal,'restart-fixture-1')).state,'submitted');
  assert.equal((await f.client.verifyRestart(journal,'restart-fixture-1')).state,'uncertain');
  assert.equal(f.restarts(),1);
});
test('tampered or expired plans do not submit any restart',async()=>{
  for(const mutate of [(p:RestartPlan)=>p.target.slot=3,(p:RestartPlan)=>p.expiresAt=now-1]){
    const f=fixture(),journal=new Journal();await f.client.prepareRestart(journal,'restart-fixture-1');mutate(journal.plan!);
    await assert.rejects(f.client.restartOnce(journal,'restart-fixture-1'));assert.equal(f.restarts(),0);
  }
});
test('plaintext origins and header injection are rejected before network access',()=>{
  assert.throws(()=>new EvrPanelClient({...target,origin:'http://host.example'},'session=fixture'));
  assert.throws(()=>new EvrPanelClient(target,'session=fixture\r\ninjected=value'));
});
test('an unsubmitted plan cannot be verified from an unrelated startup',async()=>{
  const f=fixture({logs:'2033-05-18T03:33:21.000Z | {"event":"gateway-tls-bootstrap","uid":1000}'}),journal=new Journal();
  await f.client.prepareRestart(journal,'restart-fixture-1');await assert.rejects(f.client.verifyRestart(journal,'restart-fixture-1'),/No restart/);
});
test('a later startup verifies an acknowledged restart without another mutation',async()=>{
  const f=fixture({logs:'2033-05-18T03:33:21.000Z | {"event":"gateway-tls-bootstrap","uid":1000}'}),journal=new Journal();
  await f.client.prepareRestart(journal,'restart-fixture-1');await f.client.restartOnce(journal,'restart-fixture-1');
  assert.equal((await f.client.verifyRestart(journal,'restart-fixture-1')).state,'verified');assert.equal(f.restarts(),1);
});
test('a pilot supervisor startup verifies restart when the compatibility TLS bootstrap event is absent',async()=>{
  const logs=[now-1000,now+1000].map(at=>new Date(at).toISOString()+' | {"event":"pilot-runtime-start","role":"g1","mode":"gateway","uid":1000}').join('\n');
  const f=fixture({logs}),journal=new Journal();await f.client.prepareRestart(journal,'restart-pilot-fixture-1');await f.client.restartOnce(journal,'restart-pilot-fixture-1');
  const receipt=await f.client.verifyRestart(journal,'restart-pilot-fixture-1');assert.equal(receipt.state,'verified');assert.equal(receipt.newStartupAt,now+1000);assert.equal(f.restarts(),1);
});
test('a verified restart does not regress when the host rotates its startup logs',async()=>{
  const options={logs:new Date(now+1000).toISOString()+' | {"event":"pilot-runtime-start","role":"g1"}'},f=fixture(options),journal=new Journal();
  await f.client.prepareRestart(journal,'restart-rotated-logs-1');await f.client.restartOnce(journal,'restart-rotated-logs-1');
  const verified=await f.client.verifyRestart(journal,'restart-rotated-logs-1');assert.equal(verified.state,'verified');options.logs='';
  assert.deepEqual(await f.client.verifyRestart(journal,'restart-rotated-logs-1'),verified);assert.equal(f.restarts(),1);
});
test('a filesystem claim survives reopening the journal and corrupt receipts fail closed',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'poc-host-journal-'));
  try{
    const first=new FileRestartJournal(directory),f=fixture();await f.client.prepareRestart(first,'restart-fixture-1');
    assert.equal(await first.claim('restart-fixture-1'),true);
    const recovered=new FileRestartJournal(directory);assert.equal(await recovered.claim('restart-fixture-1'),false);
    await recovered.record({operationId:'restart-fixture-1',state:'uncertain',at:now,requestedAt:now});
    assert.equal((await recovered.latest('restart-fixture-1'))?.state,'uncertain');
    await appendFile(join(directory,'restart-fixture-1.receipts.jsonl'),'partial');await assert.rejects(recovered.latest('restart-fixture-1'),/corrupt/);
    await assert.rejects(recovered.get('../escape-fixture'));
  }finally{
    const actual=await realpath(directory),parent=await realpath(tmpdir());
    if(dirname(actual)!==parent||!basename(actual).startsWith('poc-host-journal-'))throw new Error('Temporary cleanup target differs');
    await rm(actual,{recursive:true,force:true});
  }
});
