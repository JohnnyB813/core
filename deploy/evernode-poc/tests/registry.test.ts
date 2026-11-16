import test from 'node:test';
import assert from 'node:assert/strict';
import {RegistryGuard,stateHash} from '../controller/registry.ts';
import type {Snapshot,VerifiedControllerReply} from '../controller/registry.ts';
const controllers=['c1','c2','c3','c4','c5'];
const now=100000;
const snapshot:Snapshot={contractId:'pilot',sequence:10,committedAt:now,eligible:['w1','w2']};
function replies(s:Snapshot=snapshot,n=4):VerifiedControllerReply[]{return controllers.slice(0,n).map(controllerId=>({controllerId,observedAt:now,snapshot:structuredClone(s),stateHash:stateHash(s)}));}
function guard(){return new RegistryGuard('pilot',controllers,['w1','w2','w3']);}
test('four matching approved controllers admit; three do not',()=>{const g=guard();assert.equal(g.accept(replies(),now),true);assert.equal(g.mayRoute('w1',true,now),true);assert.equal(guard().accept(replies(snapshot,3),now),false);});
test('duplicate controller replies cannot manufacture quorum',()=>assert.equal(guard().accept(Array(5).fill(replies()[0]),now),false));
test('mixed committed sequences do not form quorum',()=>{const r=replies();r[3]={...r[3],snapshot:{...snapshot,sequence:11},stateHash:stateHash({...snapshot,sequence:11})};assert.equal(guard().accept(r,now),false);});
test('hash tampering and unknown contract rejected',()=>{const r=replies();r[0].snapshot.eligible=['w3'];assert.equal(guard().accept(r,now),false);assert.equal(guard().accept(replies({...snapshot,contractId:'other'}),now),false);});
test('stale and future replies rejected',()=>{assert.equal(guard().accept(replies(),now+30001),false);assert.equal(guard().accept(replies(),now-1),false);});
test('known quorum loss stops spending immediately; cached serving expires in five minutes',()=>{
  const g=guard();g.accept(replies(),now);assert.equal(g.quorumFresh(now),true);
  assert.equal(g.accept(replies(snapshot,3),now+1),false);assert.equal(g.quorumFresh(now+1),false);
  assert.equal(g.mayRoute('w1',true,now+299999),true);assert.equal(g.mayRoute('w1',true,now+300001),false);
});
test('local failure cannot be readmitted during quorum loss or by replaying a sequence',()=>{
  const g=guard();g.accept(replies(),now);assert.equal(g.mayRoute('w1',false,now),false);
  assert.equal(g.mayRoute('w1',true,now+1),false);g.accept(replies(),now+2);assert.equal(g.mayRoute('w1',true,now+2),false);
  g.accept(replies({...snapshot,sequence:11}),now+3);assert.equal(g.mayRoute('w1',true,now+3),true);
});
test('rollback, unknown backend, and conflicting duplicate identity rejected',()=>{
  const g=guard();g.accept(replies(),now);assert.equal(g.accept(replies({...snapshot,sequence:9}),now),false);
  assert.equal(guard().accept(replies({...snapshot,eligible:['unknown']}),now),false);
  const r=replies();const other={...snapshot,sequence:11};r.push({...r[0],snapshot:other,stateHash:stateHash(other)});assert.equal(guard().accept(r,now),false);
});
test('stored snapshot is independent of caller mutation',()=>{const g=guard();const r=replies();g.accept(r,now);r[0].snapshot.eligible.length=0;assert.equal(g.mayRoute('w1',true,now),true);});
