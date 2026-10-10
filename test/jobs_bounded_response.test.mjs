import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {startAndPoll,pollJob,withJobResponseBudget,runGetJob} from '../dist/tools/jobs.js';

// Exercise real HTTP against a controlled backend. The server counts starts:
// a resumed job must read the existing result, never submit a second task.
test('bounded responses resume the same job, retain its evidence and isolate concurrent calls', async () => {
  let starts=0,reads=0,done=false;
  const srv=createServer((req,res)=>{res.setHeader('Content-Type','application/json');
    if(req.method==='POST'){starts++;res.end(JSON.stringify({job_id:'control_1',status:'running'}));}
    else {reads++;res.end(JSON.stringify(done ? {status:'done',green_allowed:true,state:'proven',receipt_url:'https://fetchsandbox.com/runs/control',exit_codes:{buggy:1,fixed:0}} : {status:'running'}));}
  });
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const prior=process.env.FETCHSANDBOX_BASE_URL;process.env.FETCHSANDBOX_BASE_URL=`http://127.0.0.1:${srv.address().port}`;
  try {
    const pending=await withJobResponseBudget(15,()=>startAndPoll('/api/mcp/prove_fix',{}, {maxMs:1000,intervalMs:1}));
    assert.equal(pending.status,'running');assert.equal(pending.job_id,'control_1');
    assert.equal(pending.next_tool_call.name,'get_job');assert.equal(pending.green_allowed,undefined);
    assert.equal(starts,1);assert.ok(reads>0);
    done=true;
    const resumed=await runGetJob(pending.job_id);
    assert.equal(resumed.state,'proven');assert.deepEqual(resumed.exit_codes,{buggy:1,fixed:0});assert.equal(starts,1);
    done=false;
    const separate=await Promise.all([
      withJobResponseBudget(5,()=>pollJob('control_1',{maxMs:100,intervalMs:1})),
      withJobResponseBudget(100,()=>pollJob('control_1',{maxMs:15,intervalMs:1})).then(()=>null,e=>e),
    ]);
    assert.equal(separate[0].status,'running');assert.match(separate[1].message,/Timed out/);
    await assert.rejects(()=>runGetJob('../another-user'),/Invalid job_id/);
  } finally {if(prior===undefined)delete process.env.FETCHSANDBOX_BASE_URL;else process.env.FETCHSANDBOX_BASE_URL=prior;await new Promise(r=>srv.close(r));}
});

test('the actual MCP dispatcher returns a pending proof and resumes its measured result without repacking', async () => {
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
  const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
  const {createServer:makeMcp,registerHandlers}=await import('../dist/index.js');
  const dir=mkdtempSync(join(tmpdir(),'fs-job-dispatch-'));
  writeFileSync(join(dir,'main.py'),'print("fixture")\n');
  // A credential-shaped test value is deliberately inside the config; the
  // packer must exclude the file rather than upload it during a pending call.
  writeFileSync(join(dir,'.mcp.json'),JSON.stringify({key:'fsk_control_not_a_real_credential'}));
  let starts=0,done=false;
  const srv=createServer((req,res)=>{res.setHeader('Content-Type','application/json');
    if(req.method==='POST'){starts++;res.end(JSON.stringify({job_id:'dispatch_control',status:'running'}));}
    else res.end(JSON.stringify(done?{status:'done',green_allowed:true,state:'proven',receipt_url:'https://fetchsandbox.com/runs/control',exit_codes:{buggy:1,fixed:0}}:{status:'running'}));
  });
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const prior=process.env.FETCHSANDBOX_BASE_URL,priorRoot=process.env.FETCHSANDBOX_WORKSPACE_ROOT,priorKey=process.env.FETCHSANDBOX_API_KEY;
  process.env.FETCHSANDBOX_BASE_URL=`http://127.0.0.1:${srv.address().port}`;
  process.env.FETCHSANDBOX_WORKSPACE_ROOT=dir;process.env.FETCHSANDBOX_API_KEY='fsk_control_not_a_real_credential';
  const core=makeMcp();registerHandlers(core);const [ct,st]=InMemoryTransport.createLinkedPair();
  await core.connect(st);const client=new Client({name:'bounded-job-regression',version:'1'});await client.connect(ct);
  try {
    const start=Date.now();const pendingResult=await client.callTool({name:'prove_fix',arguments:{path:dir,diff:'--- a/main.py\n+++ b/main.py\n@@ -1 +1 @@\n-print("fixture")\n+print("changed")\n'}});
    const pending=JSON.parse(pendingResult.content[0].text);
    assert.notEqual(pendingResult.isError,true);assert.equal(pending.status,'running');assert.equal(pending.green_allowed,false);assert.ok(Date.now()-start<30_000);assert.equal(starts,1);
    done=true;const result=await client.callTool(pending.next_tool_call);const body=JSON.parse(result.content[0].text);
    assert.equal(body.state,'proven');assert.deepEqual(body.exit_codes,{buggy:1,fixed:0});assert.equal(starts,1);
  } finally {
    await client.close();await core.close();await new Promise(r=>srv.close(r));rmSync(dir,{recursive:true,force:true});
    for(const [key,value] of [['FETCHSANDBOX_BASE_URL',prior],['FETCHSANDBOX_WORKSPACE_ROOT',priorRoot],['FETCHSANDBOX_API_KEY',priorKey]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});
