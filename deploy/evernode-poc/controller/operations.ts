import {createHash} from 'node:crypto';
import {object} from '../shared/health.ts';
import {stateHash} from './registry.ts';
import type {Snapshot} from './registry.ts';
import type {AuthenticatedInput} from './reducer.ts';
import {parseMaintenance} from './maintenance.ts';
import type {Maintenance} from './maintenance.ts';
export type CanaryIntent={operationId:string;policyHash:string;authorizedAt:number;notBefore:number;expiresAt:number};
export type CanaryClaim={claimId:string;claimedAt:number};
export type CanaryResult={transactionHash:string;stage:'validated'|'host-confirmed';conflict:boolean};
export type OperationSnapshot={contractId:string;sequence:number;committedAt:number;healthStateHash:string;intent:CanaryIntent|null;claim:CanaryClaim|null;result:CanaryResult|null;maintenance:Maintenance};
export type OperationState={intent:CanaryIntent|null;claim:CanaryClaim|null;result:CanaryResult|null;snapshots:OperationSnapshot[]};
export const operationId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exact=(value:Record<string,unknown>,fields:string[])=>Object.keys(value).sort().join(',')===[...fields].sort().join(',');
const time=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
export const initialOperations=():OperationState=>({intent:null,claim:null,result:null,snapshots:[]});
export function parseOperationSnapshot(raw:unknown):OperationSnapshot{
  const value=object(raw);
  if(!exact(value,['contractId','sequence','committedAt','healthStateHash','intent','claim','result','maintenance'])||typeof value.contractId!=='string'||!time(value.sequence)||!time(value.committedAt)||!hash(value.healthStateHash))throw new Error('Invalid operation snapshot');
  let intent:CanaryIntent|null=null,claim:CanaryClaim|null=null,result:CanaryResult|null=null;
  if(value.intent!==null){const i=object(value.intent);if(!exact(i,['operationId','policyHash','authorizedAt','notBefore','expiresAt'])||!operationId(i.operationId)||!hash(i.policyHash)||!time(i.authorizedAt)||!time(i.notBefore)||!time(i.expiresAt)||i.authorizedAt>value.committedAt||i.notBefore<i.authorizedAt||i.expiresAt<=i.notBefore||i.expiresAt-i.authorizedAt>43200000)throw new Error('Invalid canary intent');intent={operationId:i.operationId,policyHash:i.policyHash,authorizedAt:i.authorizedAt,notBefore:i.notBefore,expiresAt:i.expiresAt};}
  if(value.claim!==null){const c=object(value.claim);if(!intent||!exact(c,['claimId','claimedAt'])||!operationId(c.claimId)||!time(c.claimedAt)||c.claimedAt<intent.notBefore||c.claimedAt>=intent.expiresAt||c.claimedAt>value.committedAt)throw new Error('Invalid canary claim');claim={claimId:c.claimId,claimedAt:c.claimedAt};}
  if(value.result!==null){const r=object(value.result);if(!claim||!exact(r,['transactionHash','stage','conflict'])||!hash(r.transactionHash)||!['validated','host-confirmed'].includes(String(r.stage))||typeof r.conflict!=='boolean')throw new Error('Invalid canary result');result={transactionHash:r.transactionHash,stage:r.stage as CanaryResult['stage'],conflict:r.conflict};}
  return{contractId:value.contractId,sequence:value.sequence,committedAt:value.committedAt,healthStateHash:value.healthStateHash,intent,claim,result,maintenance:parseMaintenance(value.maintenance)};
}
export function operationHash(snapshot:OperationSnapshot):string{return createHash('sha256').update(JSON.stringify(parseOperationSnapshot(snapshot))).digest('hex');}
// A separate read history preserves the health snapshot protocol used by the
// already deployed worker reporters. Operations still bind to that exact hash.
export function reduceOperations(previous:OperationState,contractId:string,owner:string|undefined,executor:string|undefined,now:number,inputs:AuthenticatedInput[],health:Snapshot,maintenance:Maintenance={revision:0,excludedWorkers:[]}):OperationState{
  const state=JSON.parse(JSON.stringify(previous)) as OperationState;
  if(!Number.isSafeInteger(now)||now!==health.committedAt||health.contractId!==contractId)throw new Error('Invalid operation consensus context');
  if(!state.intent&&owner){
    const candidates:CanaryIntent[]=[];
    for(const input of inputs){if(input.publicKey!==owner)continue;try{const b=object(input.body);if(!exact(b,['type','operationId','policyHash','notBefore','expiresAt'])||b.type!=='canary-authorize'||!operationId(b.operationId)||!hash(b.policyHash)||!time(b.notBefore)||!time(b.expiresAt)||b.notBefore<now||b.notBefore-now>21600000||b.expiresAt<=b.notBefore||b.expiresAt-now>43200000)continue;candidates.push({operationId:b.operationId,policyHash:b.policyHash,authorizedAt:now,notBefore:b.notBefore,expiresAt:b.expiresAt});}catch{}}
    // Conflicting owner requests in one round authorize neither one.
    const unique=new Map(candidates.map(c=>[JSON.stringify(c),c]));if(unique.size===1)state.intent=[...unique.values()][0];
  }
  if(state.intent&&executor&&now>=state.intent.notBefore&&now<state.intent.expiresAt&&health.eligible.includes('w3')){
    const claims:CanaryClaim[]=[];
    for(const input of inputs){if(input.publicKey!==executor)continue;try{const b=object(input.body);if(b.type==='canary-claim'&&exact(b,['type','operationId','policyHash','claimId'])&&b.operationId===state.intent.operationId&&b.policyHash===state.intent.policyHash&&operationId(b.claimId))claims.push({claimId:b.claimId,claimedAt:now});}catch{}}
    if(!state.claim&&claims.length)state.claim=claims.sort((a,b)=>a.claimId<b.claimId?-1:a.claimId>b.claimId?1:0)[0];
  }
  if(state.intent&&state.claim&&executor){
    const results:CanaryResult[]=[];
    for(const input of inputs){if(input.publicKey!==executor)continue;try{const b=object(input.body);if(b.type==='canary-result'&&exact(b,['type','operationId','claimId','transactionHash','stage'])&&b.operationId===state.intent.operationId&&b.claimId===state.claim.claimId&&hash(b.transactionHash)&&['validated','host-confirmed'].includes(String(b.stage)))results.push({transactionHash:b.transactionHash,stage:b.stage as CanaryResult['stage'],conflict:false});}catch{}}
    if(state.result)results.push(state.result);
    if(results.length){const transactions=new Set(results.map(r=>r.transactionHash));const chosen=results.sort((a,b)=>a.transactionHash<b.transactionHash?-1:a.transactionHash>b.transactionHash?1:a.stage===b.stage?0:a.stage==='host-confirmed'?-1:1)[0];state.result={...chosen,conflict:transactions.size>1||results.some(r=>r.conflict)};}
  }
  const snapshot=parseOperationSnapshot({contractId,sequence:health.sequence,committedAt:now,healthStateHash:stateHash(health),intent:state.intent,claim:state.claim,result:state.result,maintenance});
  state.snapshots=[...state.snapshots,snapshot].slice(-10);return state;
}
