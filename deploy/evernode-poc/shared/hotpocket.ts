import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export type HpKeys={publicKey:Uint8Array;privateKey:Uint8Array};
export type HpClient={connect:()=>Promise<boolean>;close:()=>Promise<void>;on:(event:string,listener:(...args:unknown[])=>void)=>void;submitContractReadRequest:(request:string,id:string,timeout:number)=>Promise<string|Uint8Array|null>};
type HpModule={generateKeys:(privateKeyHex?:string)=>Promise<HpKeys>;createClient:(urls:string[],keys:HpKeys,options:Record<string,unknown>)=>Promise<HpClient>;events:{connectionChange:string};setLogLevel:(level:number)=>void};
export function loadHotPocket():HpModule{
  const require=createRequire(import.meta.url);
  const path=require.resolve('hotpocket-js-client');
  if(createHash('sha256').update(readFileSync(path)).digest('hex')!=='1cb1fa479e862d17983b1f0dda33e6173940f80afd9bb5ec1714bb6fd989e86c')throw new Error('Strict HotPocket client patch is required before any connection');
  return require('hotpocket-js-client') as HpModule;
}
