import {createRequire} from 'node:module';
import {object} from '../shared/health.ts';
export type CanaryRpcCommand={command:'ledger_current'}|{command:'ledger_entry';index:string;ledger_index:'validated'}|{command:'tx';transaction:string;binary:false}|{command:'submit';tx_blob:string};
export type CanaryRpc=(command:CanaryRpcCommand)=>Promise<unknown>;
export type RpcSocket={on:(event:string,listener:(...args:unknown[])=>void)=>void;send:(data:string,callback:(error?:Error)=>void)=>void;terminate:()=>void};
export function canaryRpcCommand(raw:unknown):CanaryRpcCommand{
  const r=object(raw),keys=Object.keys(r).sort().join(',');
  const hash=(v:unknown)=>typeof v==='string'&&/^[A-F0-9]{64}$/.test(v);
  const valid=r.command==='ledger_current'&&keys==='command'||r.command==='ledger_entry'&&keys==='command,index,ledger_index'&&hash(r.index)&&r.ledger_index==='validated'||r.command==='tx'&&keys==='binary,command,transaction'&&hash(r.transaction)&&r.binary===false||r.command==='submit'&&keys==='command,tx_blob'&&typeof r.tx_blob==='string'&&/^(?:[A-F0-9]{2}){100,8192}$/.test(r.tx_blob);
  if(!valid)throw new Error('Canary RPC command is outside its fixed surface');
  return structuredClone(r)as CanaryRpcCommand;
}
function socket():RpcSocket{
  const require=createRequire(import.meta.url),WebSocket=createRequire(require.resolve('hotpocket-js-client'))('ws');
  return new WebSocket('wss://xahau.network',{rejectUnauthorized:true,minVersion:'TLSv1.2',maxPayload:65536,handshakeTimeout:3000})as RpcSocket;
}
/** One message on one certificate-verified connection. No reconnect, fallback,
 * automatic resubmission, signing key, HTTP cookie or arbitrary RPC method. */
export function createCanaryRpc(makeSocket:()=>RpcSocket=socket):CanaryRpc{
  return async raw=>{
    const command=canaryRpcCommand(raw),id='evernode-one-canary';
    return new Promise<unknown>((resolve,reject)=>{
      let client:RpcSocket|undefined,settled=false,sent=false,messages=0;
      const finish=(error:Error|null,result?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);try{client?.terminate();}catch{}if(error)reject(error);else resolve(result);};
      const timer=setTimeout(()=>finish(new Error('Canary RPC deadline')),5000);
      try{
        client=makeSocket();
        client.on('error',()=>finish(new Error('Canary RPC connection failed')));
        client.on('close',()=>finish(new Error('Canary RPC connection closed')));
        client.on('open',()=>{
          if(settled||sent)return;sent=true;
          try{client!.send(JSON.stringify({id,...command}),error=>{if(error)finish(new Error('Canary RPC send uncertain'));});}catch{finish(new Error('Canary RPC send uncertain'));}
        });
        client.on('message',data=>{
          if(settled)return;
          try{
            if(++messages>8)throw new Error('Unsolicited RPC messages');
            const bytes=typeof data==='string'?Buffer.from(data):Buffer.isBuffer(data)?data:null;if(!bytes||bytes.length>65536)throw new Error('RPC frame cap');
            const body=object(JSON.parse(bytes.toString('utf8')));if(body.id!==id)return;
            if(body.status!=='success'||!body.result)throw new Error('RPC result failed');finish(null,body.result);
          }catch{finish(new Error('Canary RPC returned an invalid response'));}
        });
      }catch{finish(new Error('Canary RPC connection failed'));}
    });
  };
}
