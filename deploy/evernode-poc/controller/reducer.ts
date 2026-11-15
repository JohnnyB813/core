import {isHash,isHeight,object,parseHead} from '../shared/health.ts';
import type {Head,Checkpoint,Policy} from '../shared/health.ts';
import type {Snapshot} from './registry.ts';
export type ControllerConfig={contractId:string;workers:string[];reporters:string[];policy:Policy};
export type WorkerReport={id:string;reachable:boolean;head?:Head;peers?:number;checkpointHash?:string|null;latencyMs?:number;common?:Checkpoint};
export type Report={sequence:number;observedAt:number;workers:WorkerReport[]};
export type AuthenticatedInput={publicKey:string;body:unknown};
type Decision={eligible:boolean;successes:number;failures:number;lastCounted:Record<string,number>;reason:string};
export type PoolState={sequence:number;committedAt:number;reports:Record<string,Report>;lastSequences:Record<string,number>;decisions:Record<string,Decision>;probeHistory:{height:number;createdAt:number}[];snapshots:Snapshot[]};
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
const lexical=(a:string,b:string):number=>a<b?-1:a>b?1:0;
export function initialState(config:ControllerConfig):PoolState {
  if(new Set(config.workers).size!==3||config.workers.length!==3||new Set(config.reporters).size!==5||config.reporters.length!==5)throw new Error('Pilot requires three workers and five reporters');
  return{sequence:0,committedAt:0,reports:{},lastSequences:{},decisions:Object.fromEntries([...config.workers].sort().map(id=>[id,{eligible:false,successes:0,failures:0,lastCounted:{},reason:'not-yet-reported'}])),probeHistory:[],snapshots:[]};
}
function parseReport(value:unknown,config:ControllerConfig,now:number):Report {
  const body=object(value);
  if(body.type!=='health-report'||!Number.isSafeInteger(body.sequence)||Number(body.sequence)<0||!Number.isSafeInteger(body.observedAt)||Number(body.observedAt)>now||now-Number(body.observedAt)>config.policy.freshnessMs||!Array.isArray(body.workers)||body.workers.length!==3)throw new Error('Invalid report');
  const workers=body.workers.map(value=>{
    const w=object(value);
    if(typeof w.id!=='string'||!config.workers.includes(w.id)||typeof w.reachable!=='boolean')throw new Error('Unknown worker');
    if(!w.reachable)return{id:w.id,reachable:false};
    if(!Number.isSafeInteger(w.peers)||Number(w.peers)<0||Number(w.peers)>1000||!Number.isFinite(w.latencyMs)||Number(w.latencyMs)<0||(w.checkpointHash!==null&&!isHash(w.checkpointHash)))throw new Error('Invalid worker observation');
    const common=w.common===null||w.common===undefined?undefined:object(w.common);
    if(common&&(!isHeight(common.height)||!isHash(common.hash)))throw new Error('Invalid common checkpoint');
    return{id:w.id,reachable:true,head:parseHead({code:0,data:w.head}),peers:Number(w.peers),checkpointHash:w.checkpointHash,latencyMs:Number(w.latencyMs),...(common?{common:{height:common.height as number,hash:common.hash as string}}:{})};
  }).sort((a,b)=>lexical(a.id,b.id));
  if(new Set(workers.map(w=>w.id)).size!==3)throw new Error('Duplicate worker');
  return{sequence:Number(body.sequence),observedAt:Number(body.observedAt),workers};
}
function median(values:number[]):number {const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];}
function basic(w:WorkerReport,policy:Policy):boolean{return Boolean(w.reachable&&w.head?.synced&&w.head.height>=policy.minimumHeight&&w.head.height>=policy.checkpoint.height&&w.checkpointHash===policy.checkpoint.hash&&Number(w.peers)>=policy.minPeers&&Number(w.latencyMs)<=policy.maxLatencyMs);}
// The only time source is the supplied HotPocket consensus timestamp. No I/O,
// local clocks, random values, or response-arrival order participate in this reducer.
export function reduceRound(previous:PoolState,config:ControllerConfig,now:number,inputs:AuthenticatedInput[]):PoolState {
  if(!Number.isSafeInteger(now)||now<previous.committedAt||inputs.length>100)throw new Error('Invalid round');
  const state=clone(previous);
  const candidates=new Map<string,Map<number,Report[]>>();
  for(const input of inputs){
    if(!config.reporters.includes(input.publicKey))continue;
    try{
      const report=parseReport(input.body,config,now);
      if(report.sequence<=(state.lastSequences[input.publicKey]??-1))continue;
      const bySequence=candidates.get(input.publicKey)||new Map<number,Report[]>();
      bySequence.set(report.sequence,[...(bySequence.get(report.sequence)||[]),report]);candidates.set(input.publicKey,bySequence);
    }catch{}
  }
  for(const reporter of [...candidates.keys()].sort()){
    const valid=[...candidates.get(reporter)!.entries()].filter(([_seq,reports])=>new Set(reports.map(r=>JSON.stringify(r))).size===1).sort((a,b)=>b[0]-a[0]);
    if(valid.length){const report=valid[0][1][0];state.reports[reporter]=report;state.lastSequences[reporter]=report.sequence;}
  }
  const fresh=Object.entries(state.reports).filter(([_id,r])=>r.observedAt<=now&&now-r.observedAt<=config.policy.freshnessMs).sort(([a],[b])=>lexical(a,b));
  const validProbeHeights=new Set(state.probeHistory.filter(p=>now-p.createdAt<=config.policy.freshnessMs).map(p=>p.height));
  const summaries=new Map<string,{height:number;groups:Map<string,number>}>();
  for(const id of [...config.workers].sort()){
    const good=fresh.map(([_reporter,r])=>r.workers.find(w=>w.id===id)!).filter(w=>basic(w,config.policy));
    if(good.length<3)continue;
    const groups=new Map<string,number>();
    for(const w of good){if(w.common&&validProbeHeights.has(w.common.height)&&w.common.height<=w.head!.height-10){const key=w.common.height+':'+w.common.hash;groups.set(key,(groups.get(key)||0)+1);}}
    summaries.set(id,{height:median(good.map(w=>w.head!.height)),groups});
  }
  const pairs:{referenceHeight:number;common:string}[]=[];
  const ids=[...summaries.keys()].sort();
  for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
    const a=summaries.get(ids[i])!,b=summaries.get(ids[j])!;
    if(Math.abs(a.height-b.height)>config.policy.maxLag)continue;
    for(const [common,count] of a.groups)if(count>=3&&(b.groups.get(common)||0)>=3)pairs.push({referenceHeight:Math.max(a.height,b.height),common});
  }
  pairs.sort((a,b)=>b.referenceHeight-a.referenceHeight||Number(b.common.split(':')[0])-Number(a.common.split(':')[0])||lexical(a.common,b.common));
  const agreed=pairs[0];
  for(const id of [...config.workers].sort()){
    const decision=state.decisions[id],summary=summaries.get(id);
    const healthy=Boolean(agreed&&summary&&(summary.groups.get(agreed.common)||0)>=3&&Math.abs(agreed.referenceHeight-summary.height)<=config.policy.maxLag);
    decision.reason=healthy?'healthy':fresh.length<3?'missing-report-quorum':summary?'no-current-chain-agreement':'semantic-health-failed';
    // Expired telemetry is a hard safety gate, not a repeated synthetic failure.
    if(fresh.length<3){decision.eligible=false;decision.successes=0;continue;}
    const newReports=fresh.filter(([reporter,r])=>r.sequence>(decision.lastCounted[reporter]??-1));
    if(newReports.length<3)continue;
    for(const [reporter,r] of fresh)decision.lastCounted[reporter]=r.sequence;
    if(healthy){decision.successes++;decision.failures=0;if(decision.successes>=3)decision.eligible=true;}
    else{decision.failures++;decision.successes=0;if(decision.failures>=3)decision.eligible=false;}
  }
  // Ask all reporters for the same checkpoint. Retain recent requests so poll
  // timing across consensus rounds cannot invent a disagreement.
  const heights=[...summaries.values()].map(s=>s.height).sort((a,b)=>b-a);
  const prior=state.probeHistory.at(-1);
  if(heights.length>=2&&(!prior||now-prior.createdAt>=10000)){
    const height=Math.max(config.policy.checkpoint.height,heights[1]-10);
    state.probeHistory=[...state.probeHistory.filter(p=>now-p.createdAt<=config.policy.freshnessMs),{height,createdAt:now}].slice(-4);
  }
  state.sequence++;state.committedAt=now;
  const snapshot:Snapshot={contractId:config.contractId,sequence:state.sequence,committedAt:now,eligible:Object.keys(state.decisions).filter(id=>state.decisions[id].eligible).sort(),probeHeight:state.probeHistory.at(-1)?.height??config.policy.checkpoint.height};
  state.snapshots=[...state.snapshots,snapshot].slice(-10);
  return state;
}
