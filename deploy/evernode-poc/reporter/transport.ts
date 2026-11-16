import {loadHotPocket} from '../shared/hotpocket.ts';
import type {HpKeys,HpClient} from '../shared/hotpocket.ts';
import type {ControllerEndpoint} from '../gateway/controllers.ts';
export type HpFactory=ReturnType<typeof loadHotPocket>;
async function closeBounded(client:HpClient):Promise<void>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([client.close().catch(()=>{}),new Promise<void>(resolve=>{timer=setTimeout(resolve,100);})]);}finally{if(timer)clearTimeout(timer);}
}
// One fresh pinned connection per attempt. The deadline covers connect, LCL
// lookup, input transmission and acknowledgment, including SDK promises that
// have no built-in timeout. No transaction or wallet functionality is present.
export async function sendReport(hp:HpFactory,keys:HpKeys,contractId:string,endpoint:ControllerEndpoint,body:string,sequence:number,timeoutMs=2500):Promise<boolean>{
  if(Buffer.byteLength(body)>32768)throw new Error('Report exceeds contract input limit');
  let client:HpClient|undefined,invalid=false,closing=false,expired=false,connections=0,timer:ReturnType<typeof setTimeout>|undefined;
  const work=(async()=>{
    client=await hp.createClient([endpoint.url],keys,{contractId,trustedServerKeys:[endpoint.serverKey],requiredConnectionCount:1,connectionTimeoutMs:Math.min(timeoutMs,1500)});
    if(expired){await closeBounded(client);return false;}
    client.on(hp.events.connectionChange,(server,change)=>{if(closing)return;if(server!==endpoint.url||change==='remove'||(change==='add'&&++connections>1)){invalid=true;closing=true;void client?.close();}});
    if(!await client.connect()||invalid||expired)return false;
    const submission=await client.submitContractInput(body,sequence,10,true);
    const acknowledgment=await submission.submissionStatus;
    return!invalid&&!expired&&acknowledgment.status==='accepted';
  })().catch(()=>false);
  try{return await Promise.race([work,new Promise<boolean>(resolve=>{timer=setTimeout(()=>{expired=true;resolve(false);},timeoutMs);})]);}
  finally{closing=true;if(timer)clearTimeout(timer);if(client)await closeBounded(client);}
}
