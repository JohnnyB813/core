import {loadHotPocket} from '../shared/hotpocket.ts';
import type {HpKeys,HpClient} from '../shared/hotpocket.ts';
import {object} from '../shared/health.ts';
import {parseHistory} from '../gateway/controllers.ts';
import type {ControllerEndpoint} from '../gateway/controllers.ts';
import {parseOperationSnapshot,operationHash} from '../controller/operations.ts';
import {operationQuorum} from './canary-policy.ts';
import type {VerifiedOperationReply,OperationQuorum} from './canary-policy.ts';
type Factory=(endpoint:ControllerEndpoint,keys:HpKeys,contractId:string)=>Promise<HpClient>;
async function deadline<T>(p:Promise<T>,ms:number):Promise<T>{let timer:NodeJS.Timeout|undefined;try{return await Promise.race([p,new Promise<T>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Operation read deadline')),ms);})]);}finally{clearTimeout(timer);}}
export function pairedOperationReplies(controllerId:string,contractId:string,observedAt:number,healthRaw:string|Uint8Array|null,operationRaw:string|Uint8Array|null):VerifiedOperationReply[]{
 const health=parseHistory(healthRaw,contractId),text=typeof operationRaw==='string'?operationRaw:operationRaw instanceof Uint8Array?Buffer.from(operationRaw).toString('utf8'):'';
 if(Buffer.byteLength(text)>65536)throw new Error('Operation history exceeds cap');
 const body=object(JSON.parse(text));if(body.type!=='operation-history'||!Array.isArray(body.snapshots)||body.snapshots.length>10)throw new Error('Invalid operation history');
 const replies:VerifiedOperationReply[]=[];
 for(const raw of body.snapshots){try{const entry=object(raw),operation=parseOperationSnapshot(entry.snapshot);if(operation.contractId!==contractId||operationHash(operation)!==entry.stateHash)continue;const paired=health.find(h=>h.snapshot.sequence===operation.sequence&&h.stateHash===operation.healthStateHash&&h.snapshot.committedAt===operation.committedAt);if(paired)replies.push({controllerId,observedAt,operation,health:paired.snapshot});}catch{}}
 return replies;
}
async function factory(endpoint:ControllerEndpoint,keys:HpKeys,contractId:string):Promise<HpClient>{const hp=loadHotPocket();hp.setLogLevel(1);return hp.createClient([endpoint.url],keys,{contractId,trustedServerKeys:[endpoint.serverKey],requiredConnectionCount:1,connectionTimeoutMs:1500});}
export class OperationPoller{
 #contractId:string;#endpoints:ControllerEndpoint[];#keys:HpKeys;#factory:Factory;#now:()=>number;#active=new Set<HpClient>();#closed=false;
 constructor(contractId:string,endpoints:ControllerEndpoint[],keys:HpKeys,create:Factory=factory,now:()=>number=Date.now){
  if(!/^[a-f0-9-]{36}$/.test(contractId)||endpoints.length!==5||endpoints.map(e=>e.id).sort().join(',')!=='c1,c2,c3,c4,c5')throw new Error('Five fixed operation pins required');
  for(const e of endpoints){const u=new URL(e.url);if(u.protocol!=='wss:'||u.href!==e.url||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!/^ed[0-9a-f]{64}$/.test(e.serverKey))throw new Error('Invalid operation endpoint');}
  for(const field of ['url','serverKey']as const)if(new Set(endpoints.map(e=>e[field])).size!==5)throw new Error('Repeated operation pin');
  this.#contractId=contractId;this.#endpoints=structuredClone(endpoints);this.#keys=keys;this.#factory=create;this.#now=now;
 }
 async #read(endpoint:ControllerEndpoint):Promise<VerifiedOperationReply[]>{
  if(this.#closed)return[];let client:HpClient|undefined,invalid=false,closing=false,connections=0;
  try{
   client=await deadline(this.#factory(endpoint,this.#keys,this.#contractId),2000);this.#active.add(client);
   client.on('connection_change',(server,change)=>{if(closing)return;if(server!==endpoint.url||change==='remove'||change==='add'&&++connections>1){invalid=true;closing=true;void client?.close().catch(()=>{});}});
   if(!await deadline(client.connect(),2500)||invalid||this.#closed)return[];
   const health=await deadline(client.submitContractReadRequest(JSON.stringify({type:'registry-history'}),'renewal-health',1500),2000);
   if(invalid||this.#closed)return[];
   const operations=await deadline(client.submitContractReadRequest(JSON.stringify({type:'operation-history'}),'renewal-operations',1500),2000);
   if(invalid||this.#closed)return[];
   return pairedOperationReplies(endpoint.id,this.#contractId,this.#now(),health,operations);
  }catch{return[];}finally{closing=true;if(client){await deadline(client.close().catch(()=>{}),500).catch(()=>{});this.#active.delete(client);}}
 }
 async poll():Promise<OperationQuorum|null>{const results=await Promise.all(this.#endpoints.map(e=>this.#read(e)));return operationQuorum(results.flat(),this.#endpoints.map(e=>e.id),this.#contractId,this.#now());}
 async close():Promise<void>{this.#closed=true;await Promise.all([...this.#active].map(c=>deadline(c.close().catch(()=>{}),500).catch(()=>{})));}
}
