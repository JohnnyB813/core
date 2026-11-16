const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const identity=require('../deploy/pilot-identity.json');

test('compiled controller commits and serves history through native SDK file descriptors',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'warthog-native-contract-'));
  const contract='/app/fixture/contract.cjs';
  const reader='ed'+'12'.repeat(32);
  const invoke=(readonly,type,sequence)=>{
    const input=Buffer.from(type?JSON.stringify({type}):'');
    const inputPath=path.join(root,'input');
    const outputPath=path.join(root,'output');
    fs.writeFileSync(inputPath,input);
    const infd=fs.openSync(inputPath,'r'),outfd=fs.openSync(outputPath,'w');
    const args={contract_id:identity.contractId,public_key:reader,private_key:'fixture-only',readonly,timestamp:1794775800000+sequence*2000,lcl_seq_no:sequence,lcl_hash:'a'.repeat(64),user_in_fd:3,control_fd:5,npl_fd:6,users:type?{[reader]:[4,[0,input.length]]}:{},unl:{[reader]:{active_on:0}}};
    let result;
    try{result=spawnSync(process.execPath,[contract],{cwd:root,input:JSON.stringify(args),encoding:'utf8',timeout:10000,stdio:['pipe','pipe','pipe',infd,outfd,'ignore','ignore']});}
    finally{fs.closeSync(infd);fs.closeSync(outfd);}
    assert.equal(result.error,undefined);
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stderr,'');
    assert.equal(result.stdout,'');
    if(!type)return;
    const framed=fs.readFileSync(outputPath);
    assert(framed.length>4,'native SDK must emit a framed response');
    assert.equal(framed.readUInt32BE(0),framed.length-4);
    // The JSON-protocol SDK serializes the contract's JSON string once more.
    const response=JSON.parse(JSON.parse(framed.subarray(4).toString('utf8')));
    assert.equal(response.type,type);
    return response;
  };
  try{
    invoke(false,null,1);
    const first=JSON.parse(fs.readFileSync(path.join(root,'pool-state.json'),'utf8'));
    assert.equal(first.sequence,1);
    assert.equal(first.committedAt,1794775802000);
    assert.equal(first.snapshots.length,1);
    assert.deepEqual(first.snapshots[0].eligible,[]);
    invoke(false,null,2);
    const before=fs.readFileSync(path.join(root,'pool-state.json'),'utf8');
    const history=invoke(true,'registry-history',2);
    assert.equal(history.snapshots.length,2);
    assert.equal(history.snapshots[1].snapshot.sequence,2);
    assert.match(history.snapshots[1].stateHash,/^[0-9a-f]{64}$/);
    const operations=invoke(true,'operation-history',2);
    assert.equal(operations.snapshots.length,2);
    assert.equal(fs.readFileSync(path.join(root,'pool-state.json'),'utf8'),before,'read-only requests must not change committed state');
  }finally{
    const resolved=path.resolve(root);
    assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('warthog-native-contract-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
