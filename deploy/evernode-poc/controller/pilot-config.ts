import identity from '../deploy/pilot-identity.json' with {type:'json'};
import policy from '../shared/mainnet-policy.json' with {type:'json'};
import owner from '../deploy/controller-owner.json' with {type:'json'};
import type {ControllerConfig} from './reducer.ts';
if(owner.contractId!==identity.contractId)throw new Error('Unexpected controller operation owner');
export const pilotConfig:ControllerConfig={contractId:identity.contractId,workers:['w1','w2','w3'],reporters:identity.reporters.map(r=>r.publicKey),policy,operationOwner:owner.ownerPublicKey,operationExecutor:identity.reporters.find(r=>r.id==='g1')!.publicKey};
