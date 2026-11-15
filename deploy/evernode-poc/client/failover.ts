import {allowedReadPath, boundedJson, endpoint} from '../shared/http.ts';
import {apiData, parseHead} from '../shared/health.ts';
export async function readFromGateways(gateways:string[], path:string, timeoutMs=4000): Promise<{gateway:string;body:unknown}> {
  if (!allowedReadPath(path)) throw new Error('Read path is not allowed');
  const origins=[...new Set(gateways.map(value=>endpoint(value).origin))].slice(0,2);
  if (!origins.length) throw new Error('No gateways configured');
  for (const origin of origins) {
    const url=new URL(origin);
    if (url.protocol!=='https:' && !['127.0.0.1','localhost'].includes(url.hostname)) throw new Error('Remote gateway requires HTTPS');
  }
  const errors: Error[]=[];
  for (const gateway of origins) {
    try {
      const body=await boundedJson(gateway+path,timeoutMs,262144);
      apiData(body);
      if(path==='/chain/head')parseHead(body);
      return {gateway,body};
    }catch(error){errors.push(error instanceof Error?error:new Error('Gateway failed'));}
  }
  throw new AggregateError(errors,'No gateway completed the read within the two-attempt budget');
}
