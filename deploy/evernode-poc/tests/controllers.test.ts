import test from 'node:test';
import assert from 'node:assert/strict';
import {commonReplies,ControllerPoller} from '../gateway/controllers.ts';
import type {HpClient} from '../shared/hotpocket.ts';
import type {History} from '../gateway/controllers.ts';
import type {Snapshot} from '../controller/registry.ts';
import {stateHash} from '../controller/registry.ts';
const snapshot:Snapshot={contractId:'pilot',sequence:10,committedAt:100000,eligible:['w1'],probeHeight:5000000};
function history(id:string,sequences:number[]):History{return{controllerId:id,observedAt:100100,entries:sequences.map(sequence=>{const s={...snapshot,sequence};return{snapshot:s,stateHash:stateHash(s)};})};}
test('retained histories find a common sequence across a poll straddling rounds',()=>{const replies=commonReplies([history('c1',[10,11]),history('c2',[10,11]),history('c3',[10]),history('c4',[10]),history('c5',[9])],'pilot',100100);assert.equal(replies.length,4);assert(replies.every(r=>r.snapshot.sequence===10));});
test('one identity and mixed contract data cannot manufacture quorum',()=>{const single=history('c1',[10]);assert.equal(commonReplies([single,single,single,single],'pilot',100100).length,0);const wrong=history('c4',[10]);wrong.entries[0].snapshot.contractId='other';assert.equal(commonReplies([history('c1',[10]),history('c2',[10]),history('c3',[10]),wrong],'pilot',100100).length,0);});
test('stale histories and future committed snapshots are rejected',()=>{const histories=['c1','c2','c3','c4'].map(id=>history(id,[10]));assert.equal(commonReplies(histories,'pilot',140000).length,0);assert.equal(commonReplies(histories,'pilot',99999).length,0);});
test('conflicting same-sequence history from one controller is excluded',()=>{const histories=['c1','c2','c3','c4'].map(id=>history(id,[10]));const conflict={...snapshot,eligible:['w2']};histories[0].entries.push({snapshot:conflict,stateHash:stateHash(conflict)});assert.equal(commonReplies(histories,'pilot',100100).length,0);});
test('an unresponsive fifth controller cannot stall four fresh histories or cleanup',async()=>{
  const pins=Array.from({length:5},(_,i)=>({id:'c'+(i+1),url:'wss://c'+(i+1)+'.example/',serverKey:'ed'+String(i+1).repeat(64)}));
  const fresh={...snapshot,committedAt:Date.now()},wire=JSON.stringify({type:'registry-history',snapshots:[{snapshot:fresh,stateHash:stateHash(fresh)}]});
  for(const stuck of ['connect','read','close']){
    let closed=0;
    const hp={events:{connectionChange:'connection_change'},setLogLevel:()=>{},generateKeys:async()=>({publicKey:Buffer.alloc(33),privateKey:Buffer.alloc(65)}),createClient:async(urls:string[]):Promise<HpClient>=>{
      const bad=urls[0]===pins[4].url;
      return{on:()=>{},connect:async()=>bad&&stuck==='connect'?new Promise<boolean>(()=>{}):true,close:async()=>{closed++;if(bad&&stuck==='close')await new Promise<void>(()=>{});},submitContractInput:async()=>{throw new Error('Read-only poll must never submit input');},submitContractReadRequest:async()=>bad&&stuck==='read'?new Promise<null>(()=>{}):wire};
    }};
    const poller=new ControllerPoller('pilot',pins,hp),start=performance.now();
    const histories=await poller.poll();await poller.close();
    assert(performance.now()-start<5000,stuck+' exceeded its bounded read/cleanup budget');
    assert(commonReplies(histories,'pilot',Date.now()).length>=4);
    assert.equal(closed,5);assert.equal(poller.active.size,0);
  }
});
