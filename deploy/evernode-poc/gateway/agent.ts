import {RegistryGuard} from '../controller/registry.ts';
import {assess,Hysteresis,parseHead} from '../shared/health.ts';
import type {Observation,Assessment} from '../shared/health.ts';
import {boundedJson} from '../shared/http.ts';
import {probe} from '../shared/probe.ts';
import {probePool} from '../shared/pool-probe.ts';
import type {GatewayConfig} from './config.ts';
export class GatewayAgent {
  readonly config:GatewayConfig;
  readonly registry:RegistryGuard;
  readonly states=new Map<string,Hysteresis>();
  readonly samples=new Map<string,{observation?:Observation;assessment:Assessment}>();
  sampleSequence=0;
  controllerTransport='not-configured';
  constructor(config:GatewayConfig){this.config=config;this.registry=new RegistryGuard(config.contractId,config.controllers,config.backends.map(b=>b.id));for(const b of config.backends)this.states.set(b.id,new Hysteresis());}
  async sample():Promise<void>{
    const sequence=++this.sampleSequence;
    if(this.config.backends.length===0)return;
    if(this.config.backends.length===3){
      const samples=await probePool(this.config.backends,this.config.policy,this.registry.last?.probeHeight);
      for(const backend of this.config.backends){const sample=samples.get(backend.id)!;const state=this.states.get(backend.id)!;state.update(sequence,sample.assessment.healthy);if(!sample.assessment.healthy)state.eligible=false;this.samples.set(backend.id,sample);this.registry.mayRoute(backend.id,sample.assessment.healthy&&state.eligible,Date.now());}
      return;
    }
    const reference=await boundedJson(this.config.reference+'/chain/head').then(parseHead).catch(()=>null);
    await Promise.all(this.config.backends.map(async backend=>{
      let observation:Observation|undefined;
      let assessment:Assessment={healthy:false,reason:'probe-failed'};
      try{observation=await probe(backend.url,this.config.policy.checkpoint);assessment=reference?.synced?assess(observation,reference.height,Date.now(),this.config.policy):{healthy:false,reason:'reference-unavailable'};}catch{}
      const state=this.states.get(backend.id)!;
      state.update(sequence,assessment.healthy);
      if(!assessment.healthy)state.eligible=false;
      this.samples.set(backend.id,{observation,assessment});
      this.registry.mayRoute(backend.id,assessment.healthy&&state.eligible,Date.now());
    }));
  }
  ready(id:string,now=Date.now()):boolean{
    const sample=this.samples.get(id), observation=sample?.observation;
    const fresh=Boolean(observation&&now>=observation.observedAt&&now-observation.observedAt<=this.config.policy.freshnessMs);
    return this.registry.mayRoute(id,Boolean(fresh&&sample?.assessment.healthy&&this.states.get(id)?.eligible),now);
  }
  status(now=Date.now()):unknown{return{
    phase:'compatibility',
    controllerTransport:this.controllerTransport,
    controllerQuorum:this.registry.quorumFresh(now),
    workerReady:this.config.backends.some(b=>this.ready(b.id,now)),
    workers:this.config.backends.map(b=>({id:b.id,height:this.samples.get(b.id)?.observation?.head.height??null,peers:this.samples.get(b.id)?.observation?.peers??null,latencyMs:this.samples.get(b.id)?.observation?.latencyMs??null,eligible:this.ready(b.id,now),reason:this.samples.get(b.id)?.assessment.reason??'not-yet-probed'}))
  };}
}
