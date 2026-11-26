import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const exec = promisify(execFile);
const preload = fileURLToPath(new URL('../dist/runtime/run-header-only.js',import.meta.url));
const sha = value=>createHash('sha256').update(value).digest('hex');

async function fixture(t) {
 const requests=[];
 const server=http.createServer(async(req,res)=>{
  const parts=[];for await (const part of req) parts.push(part);
  requests.push({url:req.url,method:req.method,headers:req.headers,body:Buffer.concat(parts).toString('hex')});
  res.writeHead(207,{'x-provider-marker':'unchanged','content-type':'application/octet-stream'});res.end(Buffer.from([0,255,61]));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}/sandbox/owned`;
 const run='vr_'+'a'.repeat(32);
 const launch=(code,options={})=>exec(process.execPath,['--import',preload,'--input-type=module','-e',code],{
  timeout:10000,env:{...process.env,NODE_OPTIONS:'',FETCHSANDBOX_FLOW_RUN_ID:run,FETCHSANDBOX_TEST_PROVIDER_BASES:JSON.stringify([base]),...options.env},...options,
 });
 return {requests,base,run,launch};
}

test('real HTTP keeps query, method, binary body, existing headers and provider response intact',async t=>{
 const f=await fixture(t);
 const out=await f.launch(`const r=await fetch(${JSON.stringify(f.base+'/transactions/t?escaped=%2F&empty=&include=customer')},{method:'POST',headers:{'idempotency-key':'unchanged','content-type':'application/octet-stream'},body:new Uint8Array([0,1,255])}); console.log(JSON.stringify({status:r.status,marker:r.headers.get('x-provider-marker'),body:Buffer.from(await r.arrayBuffer()).toString('hex')}));`);
 assert.deepEqual(JSON.parse(out.stdout),{status:207,marker:'unchanged',body:'00ff3d'});
 assert.equal(f.requests.length,1);const got=f.requests[0];
 assert.equal(got.url,'/sandbox/owned/transactions/t?escaped=%2F&empty=&include=customer');
 assert.equal(got.method,'POST');assert.equal(got.body,'0001ff');
 assert.equal(got.headers['idempotency-key'],'unchanged');assert.equal(got.headers['x-flow-run-id'],f.run);
});

test('an original request without expansion is not enriched; Request inputs and response streams survive',async t=>{
 const f=await fixture(t);
 await f.launch(`const r=await fetch(new Request(${JSON.stringify(f.base+'/transactions/t')},{headers:{'x-original':'kept'}}));if((await r.arrayBuffer()).byteLength!==3)throw Error('response changed');`);
 assert.equal(f.requests[0].url,'/sandbox/owned/transactions/t');assert.equal(f.requests[0].headers['x-original'],'kept');
});

test('the recorded bad-adapter failure class is blocked before any request',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.launch(`'use strict';const previous=globalThis.fetch;globalThis.fetch=(url,options)=>{const u=new URL(url);u.searchParams.set('unexpected','enrichment');return previous(u,options)};await fetch(${JSON.stringify(f.base+'/record')});`),/Cannot assign to read only property/);
 assert.equal(f.requests.length,0);
});

test('redefinition and deletion cannot replace the protected client',async t=>{
 const f=await fixture(t);
 for(const attack of ["Object.defineProperty(globalThis,'fetch',{value:()=>{}})","delete globalThis.fetch"]){
  await assert.rejects(f.launch(`'use strict';${attack};await fetch(${JSON.stringify(f.base+'/record')});`));
 }
 assert.equal(f.requests.length,0);
});

test('wrong provider path, live provider origins and a conflicting run are refused',async t=>{
 const f=await fixture(t);
 for(const url of [f.base+'-other/record','https://api.example.com/record']){
  await assert.rejects(f.launch(`await fetch(${JSON.stringify(url)});`),/outside the configured test provider boundary/);
 }
 await assert.rejects(f.launch(`await fetch(${JSON.stringify(f.base+'/record')},{headers:{'x-flow-run-id':'another-run'}});`),/different test run/);
 assert.equal(f.requests.length,0);
});

test('missing run identity and unsafe provider configuration fail before app startup',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.launch('console.log("app-started")',{env:{...process.env,NODE_OPTIONS:'',FETCHSANDBOX_FLOW_RUN_ID:'',FETCHSANDBOX_TEST_PROVIDER_BASES:JSON.stringify([f.base])}}),/requires its exact run ID/);
 await assert.rejects(f.launch('console.log("app-started")',{env:{...process.env,NODE_OPTIONS:'',FETCHSANDBOX_FLOW_RUN_ID:f.run,FETCHSANDBOX_TEST_PROVIDER_BASES:'["https://user:password@fetchsandbox.com/sandbox/owned"]'}}),/only explicit isolated test provider bases/);
 assert.equal(f.requests.length,0);
});

test('an earlier startup loader is not silently qualified',async t=>{
 const f=await fixture(t);const root=await mkdtemp(join(tmpdir(),'fs-extra-loader-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const other=join(root,'other.cjs');await writeFile(other,'globalThis.fetch=async()=>new Response("altered");');
 for(const loader of [`--require=${other}`,`-r${other}`]) {
  await assert.rejects(f.launch('console.log("app-started")',{env:{...process.env,NODE_OPTIONS:loader,FETCHSANDBOX_FLOW_RUN_ID:f.run,FETCHSANDBOX_TEST_PROVIDER_BASES:JSON.stringify([f.base])}}),error=>{
   assert(error.code!==0);assert(!error.stdout.includes('app-started'));
   return /cannot qualify other startup loaders|is not allowed in NODE_OPTIONS/.test(error.stderr);
  });
 }
 assert.equal(f.requests.length,0);
});

test('native abort behavior remains observable',async t=>{
 const f=await fixture(t);
 const out=await f.launch(`const c=new AbortController();c.abort();try{await fetch(${JSON.stringify(f.base+'/record')},{signal:c.signal});throw Error('not aborted')}catch(e){console.log(e.name)}`);
 assert.equal(out.stdout.trim(),'AbortError');assert.equal(f.requests.length,0);
});

async function originalFixture(t, f) {
 const root=await mkdtemp(join(tmpdir(),'fs-source-reference-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const app=join(root,'app.mjs');const code=`await fetch(${JSON.stringify(f.base+'/transactions/original')});`;
 await writeFile(app,code);
 const manifest=join(root,'.fetchsandbox-source.json');
 const raw=JSON.stringify({schema:'fetchsandbox-source-v1',status:'captured',files:{'app.mjs':sha(code)}});
 await writeFile(manifest,raw);
 const env={...process.env,NODE_OPTIONS:'',FETCHSANDBOX_FLOW_RUN_ID:f.run,FETCHSANDBOX_TEST_PROVIDER_BASES:JSON.stringify([f.base]),FETCHSANDBOX_RUNTIME_ROLE:'original',FETCHSANDBOX_APP_SOURCE_ROOT:root,FETCHSANDBOX_ORIGINAL_SOURCE_MANIFEST:manifest,FETCHSANDBOX_ORIGINAL_SOURCE_SHA256:sha(raw)};
 const launch=(entry=app)=>exec(process.execPath,['--import',preload,entry],{env,timeout:10000});
 return {root,app,code,manifest,raw,env,launch};
}

test('original profile checks a frozen source and ordinary entry before unchanged HTTP execution',async t=>{
 const f=await fixture(t);const original=await originalFixture(t,f);const out=await original.launch();
 const record=JSON.parse(out.stderr.split('\n').find(s=>s.startsWith('FS_RUNTIME_BINDING=')).slice('FS_RUNTIME_BINDING='.length));
 assert.equal(record.role,'original');assert.equal(record.source_check,'matched_at_startup');
 assert.equal(record.original_source_manifest_sha256,sha(original.raw));assert.equal(record.entrypoint,'app.mjs');
 assert.equal(f.requests[0].url,'/sandbox/owned/transactions/original');
});

test('a changed original source is refused instead of called the baseline',async t=>{
 const f=await fixture(t);const original=await originalFixture(t,f);
 await writeFile(original.app,original.code.replace('/transactions/original','/transactions/original?expanded=true'));
 await assert.rejects(original.launch(),/no longer matches its frozen reference/);assert.equal(f.requests.length,0);
});

test('source hashes alone do not bless an unlisted wrapper even when original files are unchanged',async t=>{
 const f=await fixture(t);const original=await originalFixture(t,f);const wrapper=join(original.root,'observer.mjs');
 await writeFile(wrapper,`await import('./app.mjs');`);
 await assert.rejects(original.launch(wrapper),/unlisted wrapper entry point/);assert.equal(f.requests.length,0);
});

test('changing or omitting the source reference cannot silently qualify an original',async t=>{
 const f=await fixture(t);const original=await originalFixture(t,f);
 await writeFile(original.manifest,original.raw+' ');
 await assert.rejects(original.launch(),/reference digest changed/);
 delete original.env.FETCHSANDBOX_ORIGINAL_SOURCE_MANIFEST;
 await assert.rejects(original.launch(),/requires its owner\/CI source reference/);assert.equal(f.requests.length,0);
});
