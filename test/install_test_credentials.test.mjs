import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {saveCredentialFile,runInstallTestCredentials,nodeRunHeaderProfile} from '../dist/tools/install_test_credentials.js';
test('the local Node profile resolves to the packaged adapter rather than the caller project',async()=>{
 const profile=nodeRunHeaderProfile();
 assert.equal(profile.profile,'node_native_fetch_header_only');
 assert((await fs.stat(profile.preload_file)).isFile());
 assert(profile.preload_file.endsWith('/dist/runtime/run-header-only.js'));
 assert.deepEqual(profile.environment,['FETCHSANDBOX_FLOW_RUN_ID','FETCHSANDBOX_TEST_PROVIDER_BASES']);
});
test('original reference comes only from the explicit workspace and excludes symlinks',async()=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'source-reference-'));
 const previous=process.env.FETCHSANDBOX_WORKSPACE_ROOT;
 try{
  process.env.FETCHSANDBOX_WORKSPACE_ROOT=root;
  assert.equal(nodeRunHeaderProfile().original_reference,undefined);
  const file=path.join(root,'.fetchsandbox-source.json');
  const raw=JSON.stringify({schema:'fetchsandbox-source-v1',status:'captured',files:{'app.mjs':'a'.repeat(64)}});
  await fs.writeFile(file,raw);
  assert.deepEqual(nodeRunHeaderProfile().original_reference,{manifest_file:file,sha256:createHash('sha256').update(raw).digest('hex')});
  await fs.rename(file,path.join(root,'actual.json'));await fs.symlink(path.join(root,'actual.json'),file);
  assert.equal(nodeRunHeaderProfile().original_reference,undefined);
 }finally{
  if(previous===undefined)delete process.env.FETCHSANDBOX_WORKSPACE_ROOT;else process.env.FETCHSANDBOX_WORKSPACE_ROOT=previous;
  await fs.rm(root,{recursive:true,force:true});
 }
});
test('private handoff preserves existing files, maps webhook setting, and returns no values',async()=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'handoff-'));
 try{
  const existing=path.join(root,'existing.env');await fs.writeFile(existing,'EXISTING=yes');
  const result=await saveCredentialFile([{name:'STRIPE_API_KEY',value:'sk_test_private'},{name:'FETCHSANDBOX_STRIPE_WEBHOOK_SECRET',value:'whsec_private'}],{FETCHSANDBOX_STRIPE_WEBHOOK_SECRET:'STRIPE_WEBHOOK_SECRET'},path.join(root,'private'));
  assert.equal((await fs.stat(result.credential_file)).mode&0o777,0o600);
  assert.equal((await fs.stat(path.dirname(result.credential_file))).mode&0o777,0o700);
  assert.equal(await fs.readFile(result.credential_file,'utf8'),'STRIPE_API_KEY=sk_test_private\nSTRIPE_WEBHOOK_SECRET=whsec_private\n');
  assert.equal(await fs.readFile(existing,'utf8'),'EXISTING=yes');
  assert(!JSON.stringify(result).includes('sk_test_private'));assert(!JSON.stringify(result).includes('whsec_private'));
  const again=await saveCredentialFile([{name:'STRIPE_API_KEY',value:'sk_test_other'}],{},path.join(root,'private'));assert.notEqual(again.credential_file,result.credential_file);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('rejects dotenv injection, duplicate mapping, unknown setting and symlink directory',async()=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'handoff-'));
 try{
  await assert.rejects(saveCredentialFile([{name:'API_KEY',value:'safe\nOTHER=bad'}],{},root));
  await assert.rejects(saveCredentialFile([{name:'A',value:'a'},{name:'B',value:'b'}],{B:'A'},root));
  await assert.rejects(saveCredentialFile([{name:'A',value:'a'}],{UNKNOWN:'B'},root));
  await fs.symlink(root,path.join(root,'link'));await assert.rejects(saveCredentialFile([{name:'A',value:'a'}],{},path.join(root,'link')));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('invalid run identity never makes an API request',async()=>{
 await assert.rejects(runInstallTestCredentials({session_id:'../other',run_id:'vr_no'}));
});
test('hosted callers cannot retrieve or write local secrets',async()=>{
 process.env.FS_MCP_HOSTED='1';
 try{await assert.rejects(runInstallTestCredentials({session_id:'vs_'+'a'.repeat(12),run_id:'vr_'+'b'.repeat(32)}),/Hosted builders/);}
 finally{delete process.env.FS_MCP_HOSTED;}
});
