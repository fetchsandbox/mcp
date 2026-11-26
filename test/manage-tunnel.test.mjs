import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import {validateMessage,forwardLocal,runManageTunnel} from '../dist/tools/manage_tunnel.js';
const request={id:'a'.repeat(32),method:'POST',path:'/stripe-webhook',headers:{'stripe-signature':'t=1,v1=abc','content-type':'application/json'},body_b64:Buffer.from('{ "id": "evt_a" }').toString('base64')};
test('reject SSRF paths, traversal and privileged headers',()=>{
 for(const path of ['//attacker/','http://attacker/','/../keys','/%2e%2e/keys','/a?token=b','/a\\b'])assert.throws(()=>validateMessage({...request,path}));
 assert.throws(()=>validateMessage({...request,headers:{host:'attacker'}}));
 assert.throws(()=>validateMessage({...request,body_b64:'not base64'}));
});
test('signed request bytes and response are preserved without following redirects',async()=>{
 let count=0;
 const s=http.createServer((req,res)=>{count++;const b=[];req.on('data',x=>b.push(x));req.on('end',()=>{assert.equal(Buffer.concat(b).toString(),'{ "id": "evt_a" }');assert.equal(req.headers['stripe-signature'],'t=1,v1=abc');res.writeHead(302,{location:'https://attacker.test','content-type':'application/json'});res.end('{"received":true}');});});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));
 try{const result=await forwardLocal(s.address().port,request);assert.equal(result.status,302);assert.equal(count,1);assert.equal(result.headers.location,undefined);}finally{await new Promise(r=>s.close(r));}
});
test('closed status and invalid ports do not create tunnel',async()=>{
 assert.deepEqual(await runManageTunnel({action:'status'}),{active:false});
 await assert.rejects(runManageTunnel({action:'open',port:80}));
 assert.deepEqual(await runManageTunnel({action:'close'}),{closed:true});
});

test('Meta signature and exact raw bytes reach the actual local HTTP handler',async()=>{
 const secret='synthetic-meta-app-secret-12345678';
 const raw=Buffer.from('{ "object": "whatsapp_business_account", "entry": [] }\n');
 const signature='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
 let requests=0;
 const local=http.createServer((req,res)=>{const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{
  requests++;const body=Buffer.concat(chunks);
  const expected='sha256='+createHmac('sha256',secret).update(body).digest('hex');
  assert.deepEqual(body,raw);assert.equal(req.headers['x-hub-signature-256'],expected);
  res.setHeader('content-type','application/json');res.end('{"received":true}');
 });});
 await new Promise(r=>local.listen(0,'127.0.0.1',r));
 try{
  const response=await forwardLocal(local.address().port,{...request,path:'/hooks/whatsapp',
   headers:{'content-type':'application/json','x-hub-signature-256':signature},body_b64:raw.toString('base64')});
  assert.equal(response.status,200);assert.equal(requests,1);
 }finally{await new Promise(r=>local.close(r));}
});

test('actual MCP callback dispatch uses private files and revokes handoff on close',async()=>{
 const fs=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
 const {createServer,registerHandlers}=await import('../dist/index.js');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fs-native-callback-test-'));await fs.chmod(dir,0o700);
 const configFile=path.join(dir,'callback.json');const secret='synthetic-meta-app-secret-12345678';
 const config={provider:'meta_whatsapp',local_path:'/hooks/whatsapp',account_id:'900001',phone_number_id:'100001',signing_secret:secret};
 await fs.writeFile(configFile,JSON.stringify(config),{mode:0o600});
 const tunnel='1'.repeat(48),callback='2'.repeat(32);let seen;let configCalls=0;
 const backend=http.createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  const origin=`http://127.0.0.1:${backend.address().port}`;
  if(req.method==='POST'&&req.url==='/api/mcp/tunnels')res.end(JSON.stringify({tunnel_id:tunnel,app_base_url:origin+'/api/relay/'+tunnel,expires_in_seconds:1800}));
  else if(req.method==='POST'&&req.url.endsWith('/callbacks')){const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{
   seen=JSON.parse(Buffer.concat(chunks));configCalls++;
   res.end(JSON.stringify({callback_id:callback,callback_url:origin+'/api/relay-callback/'+tunnel+'/'+callback,verify_token:'synthetic-test-verification-token',expires_in_seconds:1700}));
  });}
  else if(req.url.endsWith('/poll'))setTimeout(()=>{if(!res.destroyed)res.end('{"requests":[]}');},20);
  else res.end('{"closed":true}');
 });
 const local=http.createServer((_req,res)=>res.end('{}'));
 await new Promise(r=>backend.listen(0,'127.0.0.1',r));await new Promise(r=>local.listen(0,'127.0.0.1',r));
 const priorBase=process.env.FETCHSANDBOX_BASE_URL,priorKey=process.env.FETCHSANDBOX_API_KEY;
 process.env.FETCHSANDBOX_BASE_URL=`http://127.0.0.1:${backend.address().port}`;process.env.FETCHSANDBOX_API_KEY='fsk_synthetic_callback_fixture';
 const server=createServer();registerHandlers(server);const[ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);
 const client=new Client({name:'native-callback-dispatch-fixture',version:'1'});await client.connect(ct);
 const call=async args=>{const result=await client.callTool({name:'manage_tunnel',arguments:args});return {...result,body:result.isError?undefined:JSON.parse(result.content[0].text)};};
 try{
  await call({action:'open',port:local.address().port});
  await fs.chmod(configFile,0o644);
  const rejected=await call({action:'configure_callback',callback_config_file:configFile});
  assert.equal(rejected.isError,true);assert.equal(configCalls,0);assert.ok(!JSON.stringify(rejected).includes(secret));
  await fs.chmod(configFile,0o600);
  const configured=await call({action:'configure_callback',callback_config_file:configFile});
  assert.notEqual(configured.isError,true);assert.deepEqual(seen,config);
  assert.equal(configured.body.proof_status,'not_tested');assert.equal(configured.body.secret_values_returned,false);
  assert.ok(!JSON.stringify(configured).includes(secret));assert.ok(!JSON.stringify(configured).includes('synthetic-test-verification-token'));
  const installed=configured.body.credential_file;assert.equal((await fs.stat(installed)).mode&0o777,0o600);
  const saved=await fs.readFile(installed,'utf8');assert.ok(saved.includes('FETCHSANDBOX_NATIVE_CALLBACK_URL='));
  assert.ok(saved.includes('FETCHSANDBOX_NATIVE_VERIFY_TOKEN='));assert.ok(!saved.includes(secret));
  await call({action:'close'});await assert.rejects(fs.stat(installed),{code:'ENOENT'});
 }finally{
  await runManageTunnel({action:'close'});await new Promise(r=>setTimeout(r,60));await client.close();await server.close();
  await new Promise(r=>backend.close(r));await new Promise(r=>local.close(r));await fs.rm(dir,{recursive:true,force:true});
  if(priorBase===undefined)delete process.env.FETCHSANDBOX_BASE_URL;else process.env.FETCHSANDBOX_BASE_URL=priorBase;
  if(priorKey===undefined)delete process.env.FETCHSANDBOX_API_KEY;else process.env.FETCHSANDBOX_API_KEY=priorKey;
 }
});
test('instructions name actual provider handler, secure setup and independent proof',async()=>{
 const {manageTunnelTool}=await import('../dist/tools/manage_tunnel.js');
 for(const text of ['event_destinations','never invent','signature','protected handoff','execute ONCE','HTTP 200','Phalanx'])assert.ok(manageTunnelTool.description.includes(text),text);
});
test('long observation lease is explicit, bounded, and never silently extends defaults',async()=>{
 const {manageTunnelTool}=await import('../dist/tools/manage_tunnel.js');
 assert.equal(manageTunnelTool.inputSchema.properties.ttl_seconds.maximum,3600);
 for(const ttl_seconds of [59,3601,NaN,Infinity,1.5])await assert.rejects(runManageTunnel({action:'open',port:8097,ttl_seconds}),/ttl_seconds/);
 assert.deepEqual(await runManageTunnel({action:'status'}),{active:false});
});

test('actual MCP dispatch preserves explicit lease, retains default and rejects over-limit requests',async()=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
 const {createServer,registerHandlers}=await import('../dist/index.js');
 const seen=[];const leases=[];
 const backend=http.createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.method==='POST'&&req.url==='/api/mcp/tunnels'){
   const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
    const body=JSON.parse(Buffer.concat(chunks));seen.push(body);
    const id=String(leases.length+1).padStart(48,'0');leases.push(id);
    res.end(JSON.stringify({tunnel_id:id,app_base_url:'http://127.0.0.1/relay/'+id,expires_in_seconds:body.ttl_seconds??1800}));
   });
  }else if(req.url.endsWith('/poll'))setTimeout(()=>{if(!res.destroyed)res.end(JSON.stringify({requests:[]}));},20);
  else res.end(JSON.stringify({closed:true}));
 });
 const local=http.createServer((_req,res)=>res.end('{}'));
 await new Promise(r=>backend.listen(0,'127.0.0.1',r));await new Promise(r=>local.listen(0,'127.0.0.1',r));
 const priorBase=process.env.FETCHSANDBOX_BASE_URL,priorKey=process.env.FETCHSANDBOX_API_KEY;
 process.env.FETCHSANDBOX_BASE_URL=`http://127.0.0.1:${backend.address().port}`;process.env.FETCHSANDBOX_API_KEY='fsk_dispatch_fixture_not_real';
 const server=createServer();registerHandlers(server);const[ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);
 const client=new Client({name:'managed-lease-dispatch-regression',version:'1'});await client.connect(ct);
 const call=async args=>{const r=await client.callTool({name:'manage_tunnel',arguments:args});return{...r,body:JSON.parse(r.content[0].text)};};
 try{
  const extended=await call({action:'open',port:local.address().port,ttl_seconds:3600});assert.notEqual(extended.isError,true);assert.equal(extended.body.expires_in_seconds,3600);assert.deepEqual(seen[0],{ttl_seconds:3600});
  await call({action:'close'});
  const normal=await call({action:'open',port:local.address().port});assert.equal(normal.body.expires_in_seconds,1800);assert.deepEqual(seen[1],{});await call({action:'close'});
  const before=seen.length;const bad=await client.callTool({name:'manage_tunnel',arguments:{action:'open',port:local.address().port,ttl_seconds:3601}});assert.equal(bad.isError,true);assert.equal(seen.length,before);
 }finally{
  await runManageTunnel({action:'close'});await new Promise(r=>setTimeout(r,60));await client.close();await server.close();
  await new Promise(r=>backend.close(r));await new Promise(r=>local.close(r));
  if(priorBase===undefined)delete process.env.FETCHSANDBOX_BASE_URL;else process.env.FETCHSANDBOX_BASE_URL=priorBase;
  if(priorKey===undefined)delete process.env.FETCHSANDBOX_API_KEY;else process.env.FETCHSANDBOX_API_KEY=priorKey;
 }
});
