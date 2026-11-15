import {createHash} from 'node:crypto';
export type RetirementPlan={kind:'retire-unused-controller-trial';operationId:string;createdAt:number;expiresAt:number;origin:string;account:string;lease:string;slot:number;userPort:number;image:string;observedImageDigest:null;reason:string;userContractUploadPerformed:false;permanentDeletion:true;deleteRequest:{address:string;type:'delete';instance:string;instanceName:string}};
export type RetirementObservation={account:string;lease:string;slot:number;userPort:number;image:string;status:string};
export type RetirementReceipt={operationId:string;state:'uncertain'|'submitted'|'verified'|'already-claimed';at:number};
export interface RetirementJournal{claimed:()=>Promise<boolean>;claim:()=>Promise<boolean>;record:(receipt:RetirementReceipt)=>Promise<void>;}
export interface RetirementHost{observe:()=>Promise<RetirementObservation|null>;ownsLease:()=>Promise<boolean>;remove:()=>Promise<void>;}
export const retirementHash=(plan:RetirementPlan)=>createHash('sha256').update(JSON.stringify(plan)).digest('hex');
function validate(plan:RetirementPlan,approvedHash:string){
 const u=new URL(plan.origin),fields=['kind','operationId','createdAt','expiresAt','origin','account','lease','slot','userPort','image','observedImageDigest','reason','userContractUploadPerformed','permanentDeletion','deleteRequest'];
 if(Object.keys(plan).sort().join(',')!==fields.sort().join(',')||plan.kind!=='retire-unused-controller-trial'||!/^c5-node08-retire-[a-f0-9-]{36}$/.test(plan.operationId)||!Number.isSafeInteger(plan.createdAt)||!Number.isSafeInteger(plan.expiresAt)||plan.expiresAt<=plan.createdAt||plan.expiresAt-plan.createdAt>1200000||u.protocol!=='https:'||u.origin!==plan.origin||u.username||u.password||u.port&&u.port!=='443'||!/^r[1-9A-HJ-NP-Za-km-z]{24,35}$/.test(plan.account)||!(/^[A-F0-9]{64}$/).test(plan.lease)||!Number.isInteger(plan.slot)||plan.slot<1||plan.slot>9||!Number.isInteger(plan.userPort)||plan.userPort<1||plan.userPort>65535||plan.userPort%10!==plan.slot||!(/^[A-Za-z0-9_./:@-]{1,128}$/).test(plan.image)||plan.observedImageDigest!==null||typeof plan.reason!=='string'||plan.reason.length>300||plan.userContractUploadPerformed!==false||plan.permanentDeletion!==true||retirementHash(plan)!==approvedHash)throw new Error('Retirement plan differs from approval');
 const request=plan.deleteRequest;if(Object.keys(request).sort().join(',')!=='address,instance,instanceName,type'||request.address!==plan.account||request.type!=='delete'||request.instance!==String(plan.slot)||request.instanceName!==plan.lease)throw new Error('Retirement target differs');
}
function same(plan:RetirementPlan,observed:RetirementObservation){return observed.account===plan.account&&observed.lease===plan.lease&&observed.slot===plan.slot&&observed.userPort===plan.userPort&&observed.image===plan.image;}
/** A separate cleanup path for an explicitly approved, unused rental whose old
 * API lacks image digests. It retains tenant/lease/slot/payload and live ledger
 * ownership guards; it cannot restart, replace an image or relax normal checks. */
export class RetirementExecutor{
 #plan:RetirementPlan;#journal:RetirementJournal;#host:RetirementHost;#now:()=>number;
 constructor(plan:RetirementPlan,approvedHash:string,journal:RetirementJournal,host:RetirementHost,now:()=>number=Date.now){validate(plan,approvedHash);this.#plan=structuredClone(plan);this.#journal=journal;this.#host=host;this.#now=now;}
 async verify():Promise<RetirementReceipt>{const observed=await this.#host.observe(),verified=observed===null||same(this.#plan,observed)&&['inactive','destroyed','deleted'].includes(observed.status);const receipt:RetirementReceipt={operationId:this.#plan.operationId,state:verified?'verified':'uncertain',at:this.#now()};await this.#journal.record(receipt);return receipt;}
 async applyOnce():Promise<RetirementReceipt>{
  const p=this.#plan,now=this.#now();if(await this.#journal.claimed())return{operationId:p.operationId,state:'already-claimed',at:now};
  if(now<p.createdAt||now>=p.expiresAt)throw new Error('Retirement preview expired');const observed=await this.#host.observe();
  if(!observed||!same(p,observed)||!await this.#host.ownsLease())throw new Error('Retirement resource or ledger ownership changed');
  if(!await this.#journal.claim())return{operationId:p.operationId,state:'already-claimed',at:this.#now()};
  const pending:RetirementReceipt={operationId:p.operationId,state:'uncertain',at:this.#now()};await this.#journal.record(pending);
  try{await this.#host.remove();}catch{return pending;}
  await this.#journal.record({operationId:p.operationId,state:'submitted',at:this.#now()});return this.verify();
 }
}
