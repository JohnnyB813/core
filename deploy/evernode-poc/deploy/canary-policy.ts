import {createHash} from 'node:crypto';
import {object} from '../shared/health.ts';
import {operationId,parseOperationSnapshot,operationHash} from '../controller/operations.ts';
import type {OperationSnapshot} from '../controller/operations.ts';
import {stateHash} from '../controller/registry.ts';
import type {Snapshot} from '../controller/registry.ts';
export type CanaryPolicy={version:1;contractId:string;operationId:string;executorId:'g1';workerId:'w3';networkId:21337;canaryAccount:string;hostAccount:string;lease:string;rentEVR:string;moments:1;maximumFeeDrops:number;baselineExpiry:number;notBefore:number;expiresAt:number};
const fields=['version','contractId','operationId','executorId','workerId','networkId','canaryAccount','hostAccount','lease','rentEVR','moments','maximumFeeDrops','baselineExpiry','notBefore','expiresAt'];
const address=(value:unknown):value is string=>typeof value==='string'&&/^r[1-9A-HJ-NP-Za-km-z]{24,35}$/.test(value);
export function canaryPolicy(raw:unknown):CanaryPolicy{
 const p=object(raw);
 if(Object.keys(p).sort().join(',')!==fields.slice().sort().join(',')||p.version!==1||typeof p.contractId!=='string'||!/^[a-f0-9-]{36}$/.test(p.contractId)||!operationId(p.operationId)||p.executorId!=='g1'||p.workerId!=='w3'||p.networkId!==21337||!address(p.canaryAccount)||!address(p.hostAccount)||p.canaryAccount===p.hostAccount||typeof p.lease!=='string'||!(/^[A-F0-9]{64}$/).test(p.lease)||typeof p.rentEVR!=='string'||!/^0\.(?:00[1-9]|01)$/.test(p.rentEVR)||p.moments!==1||!Number.isSafeInteger(p.maximumFeeDrops)||Number(p.maximumFeeDrops)<1||Number(p.maximumFeeDrops)>1000||!Number.isSafeInteger(p.baselineExpiry)||Number(p.baselineExpiry)<=0||!Number.isSafeInteger(p.notBefore)||!Number.isSafeInteger(p.expiresAt)||Number(p.notBefore)<0||Number(p.expiresAt)<=Number(p.notBefore)||Number(p.expiresAt)-Number(p.notBefore)>43200000)throw new Error('Invalid bounded canary policy');
 return Object.fromEntries(fields.map(f=>[f,p[f]])) as CanaryPolicy;
}
export function canaryPolicyHash(raw:unknown):string{return createHash('sha256').update(JSON.stringify(canaryPolicy(raw))).digest('hex');}
// Constructed only after a fresh, one-server-pinned HotPocket read. This shape
// is never accepted from an HTTP client or an unauthenticated status endpoint.
export type VerifiedOperationReply={controllerId:string;observedAt:number;operation:OperationSnapshot;health:Snapshot};
export type OperationQuorum={operation:OperationSnapshot;health:Snapshot;controllers:string[]};
export function operationQuorum(replies:VerifiedOperationReply[],controllerIds:string[],contractId:string,now:number):OperationQuorum|null{
 if(controllerIds.length!==5||new Set(controllerIds).size!==5||!Number.isSafeInteger(now)||now<0)throw new Error('Invalid fixed operation quorum');
 const identities=new Map<string,Map<number,{hash:string;operation:OperationSnapshot;health:Snapshot}|null>>();
 for(const raw of replies){try{
  if(!controllerIds.includes(raw.controllerId)||!Number.isSafeInteger(raw.observedAt)||raw.observedAt>now||now-raw.observedAt>30000)continue;
  const operation=parseOperationSnapshot(raw.operation),health=raw.health;
  if(operation.contractId!==contractId||operation.committedAt>now||now-operation.committedAt>30000||operation.sequence!==health.sequence||operation.committedAt!==health.committedAt||health.contractId!==contractId||operation.healthStateHash!==stateHash(health)||!Array.isArray(health.eligible)||new Set(health.eligible).size!==health.eligible.length||health.eligible.some(id=>!['w1','w2','w3'].includes(id)))continue;
  const hash=operationHash(operation),sequences=identities.get(raw.controllerId)||new Map(),previous=sequences.get(operation.sequence);
  sequences.set(operation.sequence,previous===null||previous&&previous.hash!==hash?null:{hash,operation,health});identities.set(raw.controllerId,sequences);
 }catch{}}
 const groups=new Map<string,{operation:OperationSnapshot;health:Snapshot;controllers:string[]}>();
 for(const [id,sequences]of identities)for(const entry of sequences.values())if(entry){const group=groups.get(entry.hash)||{operation:entry.operation,health:entry.health,controllers:[]};group.controllers.push(id);groups.set(entry.hash,group);}
 const agreed=[...groups.values()].filter(g=>g.controllers.length>=4).sort((a,b)=>b.operation.sequence-a.operation.sequence)[0];
 return agreed?structuredClone(agreed):null;
}
export function mayExecuteCanary(raw:CanaryPolicy,quorum:OperationQuorum|null,claimId:string,now:number):boolean{
 const p=canaryPolicy(raw),q=quorum,op=q?.operation,intent=op?.intent;
 return Boolean(q&&q.controllers.length>=4&&new Set(q.controllers).size===q.controllers.length&&op&&intent&&op.contractId===p.contractId&&op.committedAt<=now&&now-op.committedAt<=30000&&now>=p.notBefore&&now<p.expiresAt&&intent.operationId===p.operationId&&intent.policyHash===canaryPolicyHash(p)&&intent.notBefore===p.notBefore&&intent.expiresAt===p.expiresAt&&op.claim?.claimId===claimId&&q.health.eligible.includes(p.workerId)&&!op.maintenance.excludedWorkers.includes(p.workerId)&&!op.result);
}
