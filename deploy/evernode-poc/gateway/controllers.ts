import {loadHotPocket} from '../shared/hotpocket.ts';
import type {HpKeys,HpClient} from '../shared/hotpocket.ts';
import {isHash,isHeight,object} from '../shared/health.ts';
import {stateHash} from '../controller/registry.ts';
import type {Snapshot,VerifiedControllerReply} from '../controller/registry.ts';
export type ControllerEndpoint={id:string;url:string;serverKey:string};
export type History={controllerId:string;observedAt:number;entries:{snapshot:Snapshot;stateHash:string}[]};
async function deadline<T>(pending:Promise<T>,ms:number):Promise<T>{let timer:NodeJS.Timeout|undefined;try{return await Promise.race([pending,new Promise<T>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Controller read deadline')),ms);})]);}finally{clearTimeout(timer);}}
export function parseHistory(value:string|Uint8Array|null,contractId:string):History['entries']{
  if(value===null)return[];
  const text=typeof value==='string'?value:Buffer.from(value).toString('utf8');
  if(Buffer.byteLength(text)>65536)throw new Error('Controller history exceeds byte limit');
  const body=object(JSON.parse(text));
  if(body.type!=='registry-history'||!Array.isArray(body.snapshots)||body.snapshots.length>10)throw new Error('Invalid history');
  const entries:History['entries']=[];
  for(const raw of body.snapshots){try{
    const entry=object(raw),s=object(entry.snapshot);
    if(s.contractId!==contractId||!Number.isSafeInteger(s.sequence)||Number(s.sequence)<0||!Number.isSafeInteger(s.committedAt)||!Array.isArray(s.eligible)||s.eligible.length>10||s.eligible.some(id=>typeof id!=='string'||!/^[a-z][a-z0-9]{0,15}$/.test(id))||new Set(s.eligible).size!==s.eligible.length)continue;
    if(s.probeHeight!==undefined&&(!isHeight(s.probeHeight)||s.probeHeight===0))continue;
    const snapshot:Snapshot={contractId,sequence:Number(s.sequence),committedAt:Number(s.committedAt),eligible:s.eligible as string[],...(s.probeHeight!==undefined?{probeHeight:Number(s.probeHeight)}:{})};
    if(!isHash(entry.stateHash)||stateHash(snapshot)!==entry.stateHash)continue;
    entries.push({snapshot,stateHash:entry.stateHash});
  }catch{}}
  return entries;
}
export function commonReplies(histories:History[],contractId:string,now:number):VerifiedControllerReply[]{
  const groups=new Map<string,Map<string,VerifiedControllerReply>>();
  // Merge by authenticated identity first: repeated network responses are one vote.
  const identities=new Map<string,History[]>();
  for(const history of histories)identities.set(history.controllerId,[...(identities.get(history.controllerId)||[]),history]);
  for(const [controllerId,list] of identities){
    const sequences=new Map<number,{snapshot:Snapshot;stateHash:string;observedAt:number}[]>();
    for(const history of list){if(history.observedAt>now||now-history.observedAt>30000)continue;for(const entry of history.entries){const s=entry.snapshot;if(s.contractId!==contractId||s.committedAt>now||now-s.committedAt>30000||stateHash(s)!==entry.stateHash)continue;sequences.set(s.sequence,[...(sequences.get(s.sequence)||[]),{...entry,observedAt:history.observedAt}]);}}
    for(const [sequence,entries] of sequences){if(new Set(entries.map(e=>e.stateHash)).size!==1)continue;const entry=entries[0],key=sequence+':'+entry.stateHash;const group=groups.get(key)||new Map<string,VerifiedControllerReply>();group.set(controllerId,{controllerId,observedAt:entry.observedAt,snapshot:entry.snapshot,stateHash:entry.stateHash});groups.set(key,group);}
  }
  const quorum=[...groups.values()].filter(group=>group.size>=4).sort((a,b)=>[...b.values()][0].snapshot.sequence-[...a.values()][0].snapshot.sequence)[0];
  return quorum?[...quorum.values()]:[];
}
export class ControllerPoller{
  readonly endpoints:ControllerEndpoint[];
  readonly contractId:string;
  readonly hp:ReturnType<typeof loadHotPocket>;
  readonly keys:Promise<HpKeys>;
  readonly active=new Set<HpClient>();
  closed=false;
  constructor(contractId:string,endpoints:ControllerEndpoint[],hp:ReturnType<typeof loadHotPocket>=loadHotPocket()){this.contractId=contractId;this.endpoints=endpoints;this.hp=hp;this.keys=this.hp.generateKeys();}
  async poll():Promise<History[]>{return Promise.all(this.endpoints.map(endpoint=>this.readOne(endpoint)));}
  async readOne(endpoint:ControllerEndpoint):Promise<History>{
    const empty=():History=>({controllerId:endpoint.id,observedAt:Date.now(),entries:[]});
    if(this.closed)return empty();
    let client:HpClient|undefined,invalid=false,closing=false,connections=0;
    try{
      client=await this.hp.createClient([endpoint.url],await deadline(this.keys,2000),{contractId:this.contractId,trustedServerKeys:[endpoint.serverKey],requiredConnectionCount:1,connectionTimeoutMs:1500});
      this.active.add(client);
      client.on(this.hp.events.connectionChange,(server,change)=>{
        if(closing)return;
        if(server!==endpoint.url||change==='remove'||(change==='add'&&++connections>1)){invalid=true;closing=true;void client?.close();}
      });
      // A new client is used for every poll. The SDK learns UNL keys internally;
      // closing on any disconnect prevents that behavior from broadening a pin.
      if(!await deadline(client.connect(),2500)||invalid||this.closed)return empty();
      const result=await deadline(client.submitContractReadRequest(JSON.stringify({type:'registry-history'}),'registry',1500),2000);
      if(invalid||this.closed)return empty();
      return{controllerId:endpoint.id,observedAt:Date.now(),entries:parseHistory(result,this.contractId)};
    }catch{return empty();}
    finally{closing=true;if(client){await deadline(client.close().catch(()=>{}),500).catch(()=>{});this.active.delete(client);}}
  }
  async close():Promise<void>{this.closed=true;await Promise.all([...this.active].map(client=>deadline(client.close().catch(()=>{}),500).catch(()=>{})));}
}
