const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {mkdtempSync,readdirSync,readFileSync,rmSync,realpathSync}=require('node:fs');
const {join,dirname,basename}=require('node:path');
const {tmpdir}=require('node:os');
const entry='/app/controller-entrypoint.sh';
function invoke(args){
  const env={...process.env};delete env.ROLE;
  return spawnSync(entry,args,{env,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
}
test('the single executable entrypoint preserves native version and new commands',()=>{
  assert.equal(invoke(['version']).status,0,'native version must run without a pilot role');
  const parent=realpathSync(tmpdir()),directory=mkdtempSync(join(parent,'warthog-controller-cli-'));
  try{
    const contract=join(directory,'contract'),created=invoke(['new',contract]);
    assert.equal(created.status,0,'native new must initialize a contract; child output stays private');
    const cfg=JSON.parse(readFileSync(join(contract,'cfg/hp.cfg'),'utf8'));
    assert.equal(typeof cfg,'object');
    assert(readdirSync(join(contract,'cfg')).length>0);
  }finally{
    const resolved=realpathSync(directory);
    assert.equal(dirname(resolved),parent);assert(basename(resolved).startsWith('warthog-controller-cli-'));
    rmSync(resolved,{recursive:true});
  }
});
test('the host run command reaches the supervisor rather than a Node script named run',()=>{
  const started=invoke(['run','/contract']);
  assert.notEqual(started.status,0);
  assert.match(started.stderr,/explicit matching pilot runtime role is required/);
  assert.doesNotMatch(started.stderr,/Cannot find module/);
});
