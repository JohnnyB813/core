import {createPrivateKey,createPublicKey} from 'node:crypto';
import {loadHotPocket} from '../shared/hotpocket.ts';
import type {HpKeys} from '../shared/hotpocket.ts';
export async function reporterKeys(secret:string,expectedPublicKey:string):Promise<HpKeys>{
  if(!/^ed[0-9a-f]{128}$/i.test(secret))throw new Error('Invalid reporter key format');
  // The SDK copies the public half from a supplied secret; independently derive
  // it from the seed before allowing this identity to authenticate a report.
  const key=Buffer.from(secret,'hex');
  const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),key.subarray(1,33)]),format:'der',type:'pkcs8'});
  const derived='ed'+(createPublicKey(privateKey).export({format:'der',type:'spki'}) as Buffer).subarray(-32).toString('hex');
  if(derived!==expectedPublicKey||key.subarray(33).toString('hex')!==derived.slice(2))throw new Error('Reporter identity does not match the protected role');
  return loadHotPocket().generateKeys(secret);
}
