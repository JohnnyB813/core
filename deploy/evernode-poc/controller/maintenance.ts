import {object} from '../shared/health.ts';
import type {AuthenticatedInput} from './reducer.ts';
export type Maintenance={revision:number;excludedWorkers:string[]};
export function parseMaintenance(value:unknown):Maintenance{
  const m=object(value);if(Object.keys(m).sort().join(',')!=='excludedWorkers,revision'||!Number.isSafeInteger(m.revision)||Number(m.revision)<0||!Array.isArray(m.excludedWorkers)||m.excludedWorkers.length>1||m.excludedWorkers.some(w=>typeof w!=='string'||!/^w[1-3]$/.test(w)))throw new Error('Invalid replacement maintenance state');
  return{revision:Number(m.revision),excludedWorkers:[...m.excludedWorkers] as string[]};
}
export function reduceMaintenance(previous:Maintenance,owner:string|undefined,now:number,inputs:AuthenticatedInput[]):Maintenance{
  const state=parseMaintenance(previous);if(!owner)return state;
  const candidates=new Map<number,Maintenance[]>();
  for(const input of inputs){if(input.publicKey!==owner)continue;try{const b=object(input.body);if(Object.keys(b).sort().join(',')!=='excludedWorkers,issuedAt,revision,type'||b.type!=='worker-maintenance'||!Number.isSafeInteger(b.issuedAt)||Number(b.issuedAt)>now||now-Number(b.issuedAt)>30000)continue;const m=parseMaintenance({revision:b.revision,excludedWorkers:b.excludedWorkers});if(m.revision<=state.revision)continue;candidates.set(m.revision,[...(candidates.get(m.revision)||[]),m]);}catch{}}
  if(!candidates.size)return state;const highest=Math.max(...candidates.keys()),values=candidates.get(highest)!;return new Set(values.map(v=>JSON.stringify(v))).size===1?values[0]:state;
}
