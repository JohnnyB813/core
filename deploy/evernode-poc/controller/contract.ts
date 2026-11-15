import {initialState,reduceRound} from './reducer.ts';
import type {PoolState,ControllerConfig,AuthenticatedInput} from './reducer.ts';
import {stateHash} from './registry.ts';
export type ContractUser={publicKey:string;inputs:[number,number][];send:(message:string)=>Promise<void>};
export type ContractContext={contractId:string;readonly:boolean;timestamp:number;users:{list:()=>ContractUser[];read:(input:[number,number])=>Promise<Buffer>}};
export type StateStore={load:()=>Promise<PoolState|null>;save:(state:PoolState)=>Promise<void>};
export async function executeContract(ctx:ContractContext,config:ControllerConfig,store:StateStore):Promise<void>{
  if(ctx.contractId!==config.contractId)throw new Error('Unexpected contract identity');
  let state=await store.load()||initialState(config);
  const users=[...ctx.users.list()].sort((a,b)=>a.publicKey<b.publicKey?-1:a.publicKey>b.publicKey?1:0);
  const inputs:AuthenticatedInput[]=[];
  const recipients:ContractUser[]=[];
  for(const user of users){
    // Drop an oversized sender rather than letting one reporter stall everybody.
    if(user.inputs.length>20)continue;
    const isReporter=config.reporters.includes(user.publicKey);
    if(!ctx.readonly&&!isReporter)continue;
    for(const descriptor of user.inputs){
      if(!Array.isArray(descriptor)||!Number.isSafeInteger(descriptor[0])||descriptor[0]<0||!Number.isSafeInteger(descriptor[1])||descriptor[1]<1||descriptor[1]>32768)continue;
      try{
        const body=JSON.parse((await ctx.users.read(descriptor)).toString('utf8'));
        if(ctx.readonly){if(body.type==='registry-history'&&!recipients.includes(user))recipients.push(user);}
        else if(body.type==='health-report'){inputs.push({publicKey:user.publicKey,body});if(!recipients.includes(user))recipients.push(user);}
      }catch{}
    }
  }
  if(!ctx.readonly){state=reduceRound(state,config,ctx.timestamp,inputs);await store.save(state);}
  const response=JSON.stringify({type:'registry-history',snapshots:state.snapshots.map(snapshot=>({snapshot,stateHash:stateHash(snapshot)}))});
  for(const user of recipients)await user.send(response);
}
