import test from 'node:test';
import assert from 'node:assert/strict';
import {commonReplies} from '../gateway/controllers.ts';
import type {History} from '../gateway/controllers.ts';
import type {Snapshot} from '../controller/registry.ts';
import {stateHash} from '../controller/registry.ts';
const snapshot:Snapshot={contractId:'pilot',sequence:10,committedAt:100000,eligible:['w1'],probeHeight:5000000};
function history(id:string,sequences:number[]):History{return{controllerId:id,observedAt:100100,entries:sequences.map(sequence=>{const s={...snapshot,sequence};return{snapshot:s,stateHash:stateHash(s)};})};}
test('retained histories find a common sequence across a poll straddling rounds',()=>{const replies=commonReplies([history('c1',[10,11]),history('c2',[10,11]),history('c3',[10]),history('c4',[10]),history('c5',[9])],'pilot',100100);assert.equal(replies.length,4);assert(replies.every(r=>r.snapshot.sequence===10));});
test('one identity and mixed contract data cannot manufacture quorum',()=>{const single=history('c1',[10]);assert.equal(commonReplies([single,single,single,single],'pilot',100100).length,0);const wrong=history('c4',[10]);wrong.entries[0].snapshot.contractId='other';assert.equal(commonReplies([history('c1',[10]),history('c2',[10]),history('c3',[10]),wrong],'pilot',100100).length,0);});
test('stale histories and future committed snapshots are rejected',()=>{const histories=['c1','c2','c3','c4'].map(id=>history(id,[10]));assert.equal(commonReplies(histories,'pilot',140000).length,0);assert.equal(commonReplies(histories,'pilot',99999).length,0);});
test('conflicting same-sequence history from one controller is excluded',()=>{const histories=['c1','c2','c3','c4'].map(id=>history(id,[10]));const conflict={...snapshot,eligible:['w2']};histories[0].entries.push({snapshot:conflict,stateHash:stateHash(conflict)});assert.equal(commonReplies(histories,'pilot',100100).length,0);});
