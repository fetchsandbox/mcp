import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
