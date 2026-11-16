import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export type HpKeys={publicKey:Uint8Array;privateKey:Uint8Array};
export type HpClient={connect:()=>Promise<boolean>;close:()=>Promise<void>;on:(event:string,listener:(...args:unknown[])=>void)=>void;submitContractReadRequest:(request:string|Uint8Array,id:string,timeout:number)=>Promise<string|Uint8Array|null>;submitContractInput:(input:string|Uint8Array,nonce:number,maxLedger:number,isOffset:boolean)=>Promise<{hash:Uint8Array;submissionStatus:Promise<{status:string}>}>};
type HpModule={generateKeys:(privateKeyHex?:string)=>Promise<HpKeys>;createClient:(urls:string[],keys:HpKeys,options:Record<string,unknown>)=>Promise<HpClient>;events:{connectionChange:string};setLogLevel:(level:number)=>void};
export function loadHotPocket():HpModule{
  const require=createRequire(import.meta.url);
  const path=require.resolve('hotpocket-js-client');
  if(createHash('sha256').update(readFileSync(path)).digest('hex')!=='e9413d49d22f907de6167c0b70be13005848c9a2c25264d0fbb151317fa4d39b')throw new Error('Strict HotPocket client patch is required before any connection');
  return require('hotpocket-js-client') as HpModule;
}
