import {randomUUID} from 'node:crypto';
import {parseControl,controlHash,verifier,ControlError,isControlId} from './protocol.ts';
import type {ControlRequest,ControlConfig} from './protocol.ts';
export type ControlReceipt={operationId:string;requestHash:string;generation:string;action:'pause'|'resume';state:'pending'|'applied';at:number;resumeAt:number|null};
export type ControlState={version:1;contractId:string;targetId:string;generation:string;pause:{until:number}|null;receipts:ControlReceipt[]};
export interface ControlStore{load:()=>Promise<ControlState|null>;save:(state:ControlState)=>Promise<void>};
export interface ControlledProcess{pause:()=>Promise<void>;resume:()=>Promise<void>};
export class FaultController {
  #config:ControlConfig;#process:ControlledProcess;#store:ControlStore;#now:()=>number;
  #state:ControlState;#verify:(request:ControlRequest,signature:string)=>void;
  #queue:Promise<unknown>=Promise.resolve();
  private constructor(config:ControlConfig,target:ControlledProcess,store:ControlStore,now:()=>number,state:ControlState){this.#config=config;this.#process=target;this.#store=store;this.#now=now;this.#state=state;this.#verify=verifier(config);}
  static async create(config:ControlConfig,target:ControlledProcess,store:ControlStore,now:()=>number=Date.now):Promise<FaultController>{
    // Validate the key before touching the process or its durable state.
    verifier(config);
    const old=await store.load();
    const receiptFields=['operationId','requestHash','generation','action','state','at','resumeAt'];
    if(old&&(old.version!==1||old.contractId!==config.contractId||old.targetId!==config.targetId||!isControlId(old.generation)||!Array.isArray(old.receipts)||old.receipts.length>256||new Set(old.receipts.map(receipt=>receipt.operationId)).size!==old.receipts.length||old.receipts.some(receipt=>Object.keys(receipt).length!==receiptFields.length||Object.keys(receipt).some(field=>!receiptFields.includes(field))||!isControlId(receipt.operationId)||!isControlId(receipt.generation)||!['pause','resume'].includes(receipt.action)||!['pending','applied'].includes(receipt.state)||!Number.isSafeInteger(receipt.at)||(receipt.resumeAt!==null&&!Number.isSafeInteger(receipt.resumeAt))||typeof receipt.requestHash!=='string'||!/^[a-f0-9]{64}$/.test(receipt.requestHash))||(old.pause!==null&&(!old.pause||Object.keys(old.pause).join(',')!=='until'||!Number.isSafeInteger(old.pause.until)))))throw new ControlError('corrupt-control-state');
    if(old?.pause)await target.resume();
    const state:ControlState={version:1,contractId:config.contractId,targetId:config.targetId,generation:randomUUID(),pause:null,receipts:old?.receipts||[]};
    await store.save(state);return new FaultController(config,target,store,now,state);
  }
  status(){return{contractId:this.#config.contractId,targetId:this.#config.targetId,generation:this.#state.generation,paused:this.#state.pause!==null,resumeAt:this.#state.pause?.until??null};}
  #serial<T>(work:()=>Promise<T>):Promise<T>{const result=this.#queue.then(work);this.#queue=result.catch(()=>{});return result;}
  async execute(value:unknown,signature:string):Promise<{receipt:ControlReceipt;status:ReturnType<FaultController['status']>}>{
    const request=parseControl(value);this.#verify(request,signature);
    return this.#serial(async()=>{
      const requestHash=controlHash(request),existing=this.#state.receipts.find(receipt=>receipt.operationId===request.operationId);
      if(existing){if(existing.requestHash!==requestHash)throw new ControlError('operation-conflict');return{receipt:existing,status:this.status()};}
      const now=this.#now();
      if(request.generation!==this.#state.generation)throw new ControlError('wrong-generation');
      if(request.issuedAt>now+5000||now-request.issuedAt>30000)throw new ControlError('expired-control');
      if(this.#state.receipts.length>=256)throw new ControlError('control-capacity');
      const receipt:ControlReceipt={operationId:request.operationId,requestHash,generation:request.generation,action:request.action,state:'pending',at:now,resumeAt:request.action==='pause'?now+request.durationMs:null};
      this.#state.receipts.push(receipt);
      if(request.action==='pause')this.#state.pause={until:receipt.resumeAt!};
      // Persist before signaling. Pending operations are reconciled, never replayed.
      await this.#store.save(this.#state);
      if(request.action==='pause')await this.#process.pause();else await this.#process.resume();
      if(request.action==='resume')this.#state.pause=null;
      receipt.state='applied';await this.#store.save(this.#state);return{receipt,status:this.status()};
    });
  }
  async sweep():Promise<void>{return this.#serial(async()=>{
    if(this.#state.pause&&this.#state.pause.until<=this.#now()){
      await this.#process.resume();this.#state.pause=null;await this.#store.save(this.#state);
    }
  });}
  async restore():Promise<void>{return this.#serial(async()=>{if(this.#state.pause){await this.#process.resume();this.#state.pause=null;await this.#store.save(this.#state);}});}
}
