import {createHash} from 'node:crypto';
import {endpoint} from '../shared/http.ts';
import {object} from '../shared/health.ts';

export type HostTarget={origin:string;account:string;lease:string;slot:number;userPort:number;image:string;imageDigest:string};
export type HostObservation=HostTarget&{status:string;expiryTimestamp:number;peerPort:number;gpTcpPort:number};
export type RestartPlan={operationId:string;target:HostTarget;targetHash:string;createdAt:number;expiresAt:number;before:HostObservation};
export type RestartState='prepared'|'submitted'|'uncertain'|'verified';
export type RestartReceipt={operationId:string;state:RestartState;at:number;requestedAt?:number;newStartupAt?:number};
export interface RestartJournal {
  create(plan:RestartPlan):Promise<void>;
  get(operationId:string):Promise<RestartPlan>;
  claim(operationId:string):Promise<boolean>;
  record(receipt:RestartReceipt):Promise<void>;
  latest(operationId:string):Promise<RestartReceipt|null>;
}
type Fetcher=(input:string|URL,init?:RequestInit)=>Promise<Response>;
const digest=(value:string)=>value.replace(/^@/,'');
export function targetHash(target:HostTarget):string {
  return createHash('sha256').update(JSON.stringify([target.origin,target.account,target.lease,target.slot,target.userPort,target.image,target.imageDigest])).digest('hex');
}
function validateTarget(value:HostTarget):HostTarget {
  const url=endpoint(value.origin);
  if(url.protocol!=='https:'||(url.port&&url.port!=='443')||!/^[r][1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value.account)||!/^[0-9A-F]{64}$/.test(value.lease)||!Number.isInteger(value.slot)||value.slot<1||value.slot>9||!Number.isInteger(value.userPort)||value.userPort<1||value.userPort>65535||value.userPort%10!==value.slot||!value.image||value.image.length>128||!/^sha256:[a-f0-9]{64}$/.test(value.imageDigest))throw new Error('Invalid named host target');
  return{origin:url.origin,account:value.account,lease:value.lease,slot:value.slot,userPort:value.userPort,image:value.image,imageDigest:value.imageDigest};
}

/** Named tenant operations only. Session cookies never enter plans or returned diagnostics. */
export class EvrPanelClient {
  #target:HostTarget;
  #cookie:string;
  #fetch:Fetcher;
  #now:()=>number;
  constructor(target:HostTarget,cookie:string,fetcher:Fetcher=fetch,now:()=>number=Date.now){
    this.#target=validateTarget(target);
    if(!cookie||cookie.length>16384||/[\r\n]/.test(cookie))throw new Error('Invalid protected host session');
    this.#cookie=cookie;this.#fetch=fetcher;this.#now=now;
  }
  async #request(path:'/api-sashilist'|'/api/',body?:Record<string,unknown>):Promise<unknown>{
    let response:Response;
    try{response=await this.#fetch(this.#target.origin+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{cookie:this.#cookie,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
    catch{throw new Error('Host API transport failed; no automatic retry');}
    if(!response.ok){await response.body?.cancel();throw new Error('Host API HTTP '+response.status);}
    if(!response.body)throw new Error('Missing host API response');
    const chunks:Uint8Array[]=[];let bytes=0;
    try{for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>1048576){await response.body.cancel().catch(()=>{});throw new Error('Host API response exceeds byte cap');}chunks.push(chunk);}}
    catch{throw new Error('Host API response read failed');}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('Host API response is not JSON');}
  }
  async observe():Promise<HostObservation>{
    const body=object(await this.#request('/api-sashilist'));
    if(!Array.isArray(body.sashiList))throw new Error('Host instance list is missing');
    const candidates=body.sashiList.map(object).filter(row=>Number(row.user_port)===this.#target.userPort);
    if(candidates.length!==1)throw new Error('Named instance is missing or ambiguous');
    const row=candidates[0];
    if(row.tenant!==this.#target.account||row.name!==this.#target.lease||row.image!==this.#target.image||typeof row.imageDigest!=='string'||digest(row.imageDigest)!==this.#target.imageDigest)throw new Error('Named instance identity changed');
    if(!Number.isSafeInteger(row.expiry_timestamp)||Number(row.expiry_timestamp)*1000<=this.#now()||typeof row.status!=='string'||!['active','running'].includes(row.status))throw new Error('Named instance is inactive or its lease expired');
    const ports=[row.peer_port,row.gp_tcp_port].map(Number);
    if(ports.some(port=>!Number.isInteger(port)||port<1||port>65535))throw new Error('Invalid instance port metadata');
    return{...this.#target,status:row.status,expiryTimestamp:Number(row.expiry_timestamp),peerPort:ports[0],gpTcpPort:ports[1]};
  }
  async diagnostics():Promise<{checkedAt:number;lines:string[];startupTimes:number[]}>{
    await this.observe();
    const body=object(await this.#request('/api/',{address:this.#target.account,type:'docker_logs',instance:this.#target.slot}));
    const data=Array.isArray(body.data)?body.data.filter(line=>typeof line==='string').join('\n'):typeof body.data==='string'?body.data:'';
    const lines=data.split('\n').filter(line=>!/private.?key|password|secret|authorization|cookie|bearer|ed[0-9a-f]{128}/i.test(line)&&/\[evr\] data_dir=|Chain info:|RPC endpoint|RPC public endpoint|P2P endpoint|P2P advertised port|Warthog Node|"event":"gateway-tls-bootstrap"|"event":"gateway-start"/.test(line)).slice(-100);
    const startupTimes=lines.filter(line=>/\[evr\] data_dir=|"event":"gateway-tls-bootstrap"/.test(line)).map(line=>Date.parse(line.split(' | ',1)[0])).filter(Number.isFinite);
    return{checkedAt:this.#now(),lines,startupTimes};
  }
  async prepareRestart(journal:RestartJournal,operationId:string):Promise<RestartPlan>{
    if(!/^[a-z0-9-]{12,80}$/.test(operationId))throw new Error('Invalid restart operation ID');
    const before=await this.observe(),createdAt=this.#now();
    const plan={operationId,target:{...this.#target},targetHash:targetHash(this.#target),createdAt,expiresAt:Math.min(createdAt+20*60*1000,before.expiryTimestamp*1000),before};
    await journal.create(plan);return plan;
  }
  async restartOnce(journal:RestartJournal,operationId:string):Promise<RestartReceipt>{
    const plan=await journal.get(operationId),now=this.#now();
    if(plan.operationId!==operationId||plan.targetHash!==targetHash(plan.target)||plan.targetHash!==targetHash(this.#target)||now<plan.createdAt||now>=plan.expiresAt)throw new Error('Restart plan is invalid, expired or for another target');
    await this.observe();
    if(!await journal.claim(operationId))throw new Error('Restart was already claimed; verify it without resubmitting');
    // The durable uncertain state precedes the request. A crash or lost response
    // must never cause the same action to be submitted automatically again.
    await journal.record({operationId,state:'uncertain',at:now,requestedAt:now});
    try{
      const result=object(await this.#request('/api/',{address:this.#target.account,type:'restart',instance:this.#target.slot}));
      if(result.success===false||result.error)throw new Error('Host did not acknowledge restart');
      const receipt:RestartReceipt={operationId,state:'submitted',at:now,requestedAt:now};await journal.record(receipt);return receipt;
    }catch{return{operationId,state:'uncertain',at:now,requestedAt:now};}
  }
  async verifyRestart(journal:RestartJournal,operationId:string):Promise<RestartReceipt>{
    const plan=await journal.get(operationId);
    if(plan.targetHash!==targetHash(this.#target))throw new Error('Restart verification target differs');
    const previous=await journal.latest(operationId);
    if(!previous?.requestedAt)throw new Error('No restart submission was recorded');
    const diagnostics=await this.diagnostics();
    const newStartupAt=diagnostics.startupTimes.find(time=>time>previous.requestedAt!);
    const receipt:RestartReceipt={operationId,state:newStartupAt?'verified':'uncertain',at:this.#now(),requestedAt:previous.requestedAt,...(newStartupAt?{newStartupAt}:{})};
    await journal.record(receipt);return receipt;
  }
}
