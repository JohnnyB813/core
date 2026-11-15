// Disposable fixture identities only. This file is never run by a live runtime.
const fs=require('node:fs');
const crypto=require('node:crypto');
const hp=require('hotpocket-js-client');
(async()=>{
 const identity=JSON.parse(fs.readFileSync('deploy/pilot-identity.json','utf8'));
 const reporters=[],secrets={};
 for(const id of ['w1','w2','w3','g1','g2']){const keys=await hp.generateKeys();reporters.push({id,publicKey:Buffer.from(keys.publicKey).toString('hex')});secrets[id]=Buffer.from(keys.privateKey).toString('hex');}
 const keys=crypto.generateKeyPairSync('ed25519');
 fs.writeFileSync('deploy/pilot-identity.json',JSON.stringify({...identity,reporters}));
 fs.writeFileSync('deploy/fault-operator.json',JSON.stringify({version:1,contractId:identity.contractId,operatorPublicKey:keys.publicKey.export({format:'der',type:'spki'}).toString('base64')}));
 fs.writeFileSync('tests/runtime-secrets.json',JSON.stringify({contractId:identity.contractId,operator:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),reporters:secrets}),{mode:0o600});
 console.log('Prepared disposable fixture identities; no operator vault was accessed.');
})().catch(()=>{console.error('Fixture preparation failed.');process.exitCode=1;});
