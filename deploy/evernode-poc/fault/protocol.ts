import {createHash,createPublicKey,sign,verify} from 'node:crypto';
import type {KeyObject} from 'node:crypto';
import {object} from '../shared/health.ts';
export type ControlRequest={version:1;contractId:string;targetId:string;generation:string;operationId:string;action:'pause'|'resume';issuedAt:number;durationMs:number};
export type ControlConfig={contractId:string;targetId:string;operatorPublicKey:string};
export class ControlError extends Error {code:string;constructor(code:string){super(code);this.code=code;}}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const isControlId=(value:unknown):value is string=>typeof value==='string'&&uuid.test(value);
export function parseControl(value:unknown):ControlRequest{
  const body=object(value),keys=['version','contractId','targetId','generation','operationId','action','issuedAt','durationMs'];
  if(Object.keys(body).length!==keys.length||Object.keys(body).some(key=>!keys.includes(key))||body.version!==1||typeof body.contractId!=='string'||body.contractId.length<1||body.contractId.length>100||typeof body.targetId!=='string'||!/^(?:w[1-3]|g[12]|c[1-5])$/.test(body.targetId)||typeof body.generation!=='string'||!uuid.test(body.generation)||typeof body.operationId!=='string'||!uuid.test(body.operationId)||!['pause','resume'].includes(String(body.action))||!Number.isSafeInteger(body.issuedAt)||!Number.isSafeInteger(body.durationMs)||Number(body.durationMs)<0||Number(body.durationMs)>480000||(body.action==='pause'&&Number(body.durationMs)<1)||(body.action==='resume'&&body.durationMs!==0))throw new ControlError('invalid-control');
  return body as ControlRequest;
}
export function controlBytes(request:ControlRequest):Buffer{
  return Buffer.from(JSON.stringify(['warthog-evernode-pilot-control-v1',request.version,request.contractId,request.targetId,request.generation,request.operationId,request.action,request.issuedAt,request.durationMs]));
}
export function controlHash(request:ControlRequest):string{return createHash('sha256').update(controlBytes(request)).digest('hex');}
export function signControl(request:ControlRequest,key:KeyObject|string):string{return sign(null,controlBytes(parseControl(request)),key).toString('base64');}
export function verifier(config:ControlConfig):(request:ControlRequest,signature:string)=>void{
  if(typeof config.contractId!=='string'||!config.contractId||config.contractId.length>100||!/^(?:w[1-3]|g[12]|c[1-5])$/.test(config.targetId))throw new ControlError('invalid-control-configuration');
  const key=createPublicKey({key:Buffer.from(config.operatorPublicKey,'base64'),format:'der',type:'spki'});
  if(key.asymmetricKeyType!=='ed25519')throw new ControlError('invalid-operator-key');
  return(request,signature)=>{
    if(request.contractId!==config.contractId||request.targetId!==config.targetId)throw new ControlError('wrong-target');
    const decoded=Buffer.from(signature,'base64');
    if(decoded.length!==64||decoded.toString('base64')!==signature||!verify(null,controlBytes(request),key,decoded))throw new ControlError('unauthorized');
  };
}
export function verifyOperator(publicKey:string,message:Buffer,signature:string):void{
  const key=createPublicKey({key:Buffer.from(publicKey,'base64'),format:'der',type:'spki'}),decoded=Buffer.from(signature,'base64');
  if(key.asymmetricKeyType!=='ed25519'||decoded.length!==64||decoded.toString('base64')!==signature||!verify(null,message,key,decoded))throw new ControlError('unauthorized');
}
