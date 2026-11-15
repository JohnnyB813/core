import {boundedJson,endpoint} from '../shared/http.ts';
import {object} from '../shared/health.ts';
import {isControlId} from '../fault/protocol.ts';
import type {CanaryPolicy} from './canary-policy.ts';
export type CanaryHostBinding={origin:string;userPort:number;controlOrigin:string;generation:string;volumeId:string;imageDigest:string};
export type CanaryJsonReader=(url:string,timeoutMs:number,maxBytes:number)=>Promise<unknown>;
export function canaryHostBinding(raw:CanaryHostBinding):CanaryHostBinding{
  const origin=endpoint(raw.origin),control=endpoint(raw.controlOrigin);
  if(Object.keys(raw).sort().join(',')!=='controlOrigin,generation,imageDigest,origin,userPort,volumeId'||origin.protocol!=='https:'||origin.port||origin.origin!==raw.origin||control.protocol!=='https:'||control.hostname!==origin.hostname||control.origin!==raw.controlOrigin||!Number.isInteger(raw.userPort)||raw.userPort<1||raw.userPort>65535||!isControlId(raw.generation)||!isControlId(raw.volumeId)||!/^sha256:[a-f0-9]{64}$/.test(raw.imageDigest))throw new Error('Invalid fixed canary host binding');
  return structuredClone(raw);
}
export async function observeCanaryHost(policy:CanaryPolicy,raw:CanaryHostBinding,read:CanaryJsonReader=boundedJson):Promise<number|null>{
  const h=canaryHostBinding(raw);
  const [list,status]=await Promise.all([read(h.origin+'/api-sashilist',3000,1048576).then(object),read(h.controlOrigin+'/pilot/status',3000,65536).then(object)]);
  if(!Array.isArray(list.sashiList)||list.sashiList.length>1000)return null;
  const rows=list.sashiList.map(object).filter(r=>Number(r.user_port)===h.userPort);if(rows.length!==1)return null;const row=rows[0],observation=object(status.observations||{}),resources=object(observation.resources||{});
  if(typeof row.imageDigest!=='string'||row.imageDigest.replace(/^@/,'')!==h.imageDigest||!['active','running'].includes(String(row.status))||Number(row.gp_tcp_port)!==Number(new URL(h.controlOrigin).port||443)||!Number.isSafeInteger(row.expiry_timestamp)||status.contractId!==policy.contractId||status.targetId!==policy.workerId||status.generation!==h.generation||resources.volumeId!==h.volumeId||observation.applicationRunning!==true)return null;
  return Number(row.expiry_timestamp);
}
