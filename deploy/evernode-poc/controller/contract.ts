import {initialState,reduceRound} from './reducer.ts';
import type {PoolState,ControllerConfig,AuthenticatedInput} from './reducer.ts';
import {stateHash} from './registry.ts';
import {operationHash} from './operations.ts';
export type ContractUser={publicKey:string;inputs:[number,number][];send:(message:string)=>Promise<void>};
export type ContractContext={contractId:string;readonly:boolean;timestamp:number;users:{list:()=>ContractUser[];read:(input:[number,number])=>Promise<Buffer>}};
export type StateStore={load:()=>Promise<PoolState|null>;save:(state:PoolState)=>Promise<void>};
export async function executeContract(ctx:ContractContext,config:ControllerConfig,store:StateStore):Promise<void>{
  if(ctx.contractId!==config.contractId)throw new Error('Unexpected contract identity');
  let state=await store.load()||initialState(config);
  const users=[...ctx.users.list()].sort((a,b)=>a.publicKey<b.publicKey?-1:a.publicKey>b.publicKey?1:0);
  const inputs:AuthenticatedInput[]=[];
  const recipients=new Map<ContractUser,Set<'registry-history'|'operation-history'>>();
  const recipient=(user:ContractUser,type:'registry-history'|'operation-history')=>{const types=recipients.get(user)||new Set();types.add(type);recipients.set(user,types);};
  for(const user of users){
    // Drop an oversized sender rather than letting one reporter stall everybody.
    if(user.inputs.length>20)continue;
    const isReporter=config.reporters.includes(user.publicKey);
    const isOperator=user.publicKey===config.operationOwner||user.publicKey===config.operationExecutor;
    if(!ctx.readonly&&!isReporter&&!isOperator)continue;
    for(const descriptor of user.inputs){
      if(!Array.isArray(descriptor)||!Number.isSafeInteger(descriptor[0])||descriptor[0]<0||!Number.isSafeInteger(descriptor[1])||descriptor[1]<1||descriptor[1]>32768)continue;
      try{
        const body=JSON.parse((await ctx.users.read(descriptor)).toString('utf8'));
        if(ctx.readonly){if(body.type==='registry-history'||body.type==='operation-history')recipient(user,body.type);}
        else if(body.type==='health-report'&&isReporter){inputs.push({publicKey:user.publicKey,body});recipient(user,'registry-history');}
        else if(isOperator&&['canary-authorize','canary-claim','canary-result','worker-maintenance'].includes(body.type)){inputs.push({publicKey:user.publicKey,body});recipient(user,'operation-history');}
      }catch{}
    }
  }
  if(!ctx.readonly){state=reduceRound(state,config,ctx.timestamp,inputs);await store.save(state);}
  const response=JSON.stringify({type:'registry-history',snapshots:state.snapshots.map(snapshot=>({snapshot,stateHash:stateHash(snapshot)}))});
  const operations=JSON.stringify({type:'operation-history',snapshots:(state.operations?.snapshots||[]).map(snapshot=>({snapshot,stateHash:operationHash(snapshot)}))});
  for(const [user,types] of recipients){if(types.has('registry-history'))await user.send(response);if(types.has('operation-history'))await user.send(operations);}
}
