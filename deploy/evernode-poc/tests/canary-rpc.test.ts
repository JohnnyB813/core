import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createCanaryRpc,canaryRpcCommand} from '../deploy/canary-rpc.ts';
import type {RpcSocket} from '../deploy/canary-rpc.ts';
class Socket extends EventEmitter implements RpcSocket{
  sent:Record<string,unknown>[]=[];terminations=0;reply:(body:Record<string,unknown>)=>void=()=>{};
  send(data:string,callback:(error?:Error)=>void){const body=JSON.parse(data);this.sent.push(body);callback();queueMicrotask(()=>this.reply(body));}
  terminate(){this.terminations++;queueMicrotask(()=>this.emit('close'));}
}
test('one request sends once even if the connection reports open twice',async()=>{
  const sockets:Socket[]=[];const rpc=createCanaryRpc(()=>{const s=new Socket();sockets.push(s);s.reply=b=>s.emit('message',Buffer.from(JSON.stringify({id:b.id,status:'success',result:{ledger_current_index:1000}})));queueMicrotask(()=>{s.emit('open');s.emit('open');});return s;});
  assert.deepEqual(await rpc({command:'ledger_current'}),{ledger_current_index:1000});assert.equal(sockets.length,1);assert.equal(sockets[0].sent.length,1);assert.equal(sockets[0].terminations,1);
});
test('lost submit response closes the sole connection without retry or reconnect',async()=>{
  let created=0;const s=new Socket();s.reply=()=>s.emit('close');const rpc=createCanaryRpc(()=>{created++;queueMicrotask(()=>s.emit('open'));return s;});
  await assert.rejects(rpc({command:'submit',tx_blob:'AA'.repeat(100)}),/closed/);assert.equal(created,1);assert.equal(s.sent.length,1);assert.equal(s.sent[0].command,'submit');assert.equal(s.terminations,1);
});
test('unsupported methods, extra fields and unbounded payloads never open a socket',async()=>{
  let created=0;const rpc=createCanaryRpc(()=>{created++;return new Socket();});
  for(const raw of [{command:'sign',secret:'fixture-only'},{command:'ledger_current',url:'wss://foreign.example'},{command:'tx',transaction:'A'.repeat(64),binary:true},{command:'submit',tx_blob:'AA'.repeat(8193)}])assert.throws(()=>canaryRpcCommand(raw));
  await assert.rejects(rpc({command:'sign'}as never));assert.equal(created,0);
});
test('foreign response IDs have no result and malformed matching data fails closed',async()=>{
  for(const malformed of [false,true]){
    const s=new Socket(),rpc=createCanaryRpc(()=>{queueMicrotask(()=>s.emit('open'));return s;});s.reply=b=>{s.emit('message',Buffer.from(JSON.stringify({id:'foreign',status:'success',result:{fake:true}})));s.emit('message',Buffer.from(malformed?'bad-json':JSON.stringify({id:b.id,status:'success',result:{ledger_current_index:1000}})));};
    if(malformed)await assert.rejects(rpc({command:'ledger_current'}),/invalid response/);else assert.deepEqual(await rpc({command:'ledger_current'}),{ledger_current_index:1000});assert.equal(s.sent.length,1);assert.equal(s.terminations,1);
  }
});
