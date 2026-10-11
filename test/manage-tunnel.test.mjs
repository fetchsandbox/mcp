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
