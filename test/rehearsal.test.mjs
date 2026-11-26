import test from 'node:test';
import assert from 'node:assert/strict';
import {runRehearsalAction, rehearsalTools} from '../dist/tools/rehearsal.js';
import {createServer, registerHandlers, ALL_TOOLS, HOSTED_TOOL_NAMES} from '../dist/index.js';
import {withRequestIdentity} from '../dist/request_context.js';

// Existing validation/planning response shapes, as exercised by the existing
// readiness and planning-job tests. These are protocol checks, not app proof.
const json = body => new Response(JSON.stringify(body), {status:200,headers:{'content-type':'application/json'}});
async function withFetch(handler, action) {
  const prior=globalThis.fetch; const calls=[];
  globalThis.fetch=async(url,options={})=>{calls.push({url,body:options.body && JSON.parse(options.body),headers:options.headers});return handler(calls.at(-1),calls.length);};
  try{return await action(calls);}finally{globalThis.fetch=prior;}
}

test('goal alone requests project inspection without network or guessed providers',async()=>{
  await withFetch(()=>{throw Error('No request permitted');},async calls=>{
    const r=await runRehearsalAction('plan_rehearsal',{goal:'Test my lead follow-up'});
    assert.equal(r.stage,'inspect_project');assert.equal(r.environment_created,false);assert.equal(r.app_verified,false);assert.equal(calls.length,0);
    assert.match(r.agent_next_step,/authorized project/);assert.doesNotMatch(JSON.stringify(r),/"providers":\["stripe"\]/);
  });
});

test('connect is a single owned submission with a populated continuation, not execution',async()=>{
  const goal='Test purchases, with repeat delivery.';
  await withFetch(()=>json({session_id:'vs_owned',legs:{paddle:{api_key:'fake_secret_do_not_return'}},available_suites:['application_workflow_v1'],coverage_policy:{dimensions:['duplicate_replay']}}),async calls=>{
    const r=await runRehearsalAction('plan_rehearsal',{goal,application:{providers:['paddle','resend'],origin:'https://disposable.example',version:'v1',entry_points:['/paddle-webhook']}});
    assert.equal(calls.length,1);assert.equal(calls[0].body.environment_scope,'owner');assert.equal(calls[0].body.execute,false);
    assert.equal(calls[0].body.application_context,null);assert.equal(r.app_verified,false);
    assert.deepEqual(r.next_tool_call,{tool:'plan_rehearsal',arguments:{goal,session_id:'vs_owned',application:{version:'v1',entry_points:['/paddle-webhook']}}});
    assert.deepEqual(r.coverage_policy,{dimensions:['duplicate_replay']});
    assert.doesNotMatch(JSON.stringify(r),/fake_secret_do_not_return|api_key/);
  });
});

test('provider-free HTTP app requires explicit empty providers and an origin',async()=>{
  await withFetch(()=>json({session_id:'vs_http'}),async calls=>{
    const r=await runRehearsalAction('plan_rehearsal',{goal:'Verify approval rules',application:{providers:[],origin:'https://disposable.example'}});
    assert.equal(r.session_id,'vs_http');assert.deepEqual(calls[0].body.providers,[]);
  });
});

test('planning resumes the exact session through the existing job owner and never creates another environment',async()=>{
  await withFetch((call)=>json(call.body ? {status:'running',job_id:'job_plan'} : {status:'done',app_verified:false,verification_plan:{rules:[{id:'A1',status:'unmeasured'}],business_questions:['What happens when recovery is exhausted?']}}),async calls=>{
    const r=await runRehearsalAction('plan_rehearsal',{goal:'The exact user goal',session_id:'vs_owned',application:{version:'v1',state_store:'SQLite'}});
    assert.equal(calls.filter(x=>x.body).length,1);assert.equal(calls[0].body.session_id,'vs_owned');assert.equal(calls[0].body.async_job,true);
    assert.deepEqual(calls[0].body.application_context,{goal:'The exact user goal',app_version:'v1',state_store:'SQLite'});
    assert.equal(r.session_id,'vs_owned');assert.equal(r.app_verified,false);assert.equal(r.verification_plan.rules[0].status,'unmeasured');
    assert.deepEqual(r.verification_plan.business_questions,['What happens when recovery is exhausted?']);
  });
});

test('bad inputs, target changes, and oversized summaries fail before an environment is created',async()=>{
  const inputs=[{goal:''},{goal:'test',application:{providers:'stripe'}},{goal:'test',application:{providers:['stripe','stripe']}},
    {goal:'test',session_id:'vs_owned',application:{providers:['stripe']}},
    {goal:'test',application:{providers:['stripe'],raw_source:'secret'}},
    {goal:'test',application:{providers:['stripe'],entry_points:['x'.repeat(17000)]}}];
  await withFetch(()=>{throw Error('No request permitted');},async calls=>{
    for(const input of inputs)await assert.rejects(runRehearsalAction('plan_rehearsal',input));
    assert.equal(calls.length,0);
  });
});

test('run, status and stop preserve the exact attempt and existing verdict without combining actions',async()=>{
  await withFetch(()=>json({session_id:'vs_owned',run_id:'vr_exact',status:'failed',app_verified:false,verdict:'failed',checks:[{id:'replay',status:'failed'}],receipt_url:'https://fetchsandbox.com/runs/recorded'}),async calls=>{
    for(const name of ['run_rehearsal','get_rehearsal','stop_rehearsal']) {
      const r=await runRehearsalAction(name,{session_id:'vs_owned',run_id:'vr_exact'});
      assert.equal(r.verdict,'failed');assert.equal(r.checks[0].status,'failed');assert.equal(r.app_verified,false);
    }
    assert.ok(calls.every(c=>c.body.session_id==='vs_owned' && c.body.run_id==='vr_exact'));
    assert.deepEqual(calls.map(c=>[c.body.execute,c.body.cancel]),[[true,false],[false,false],[false,true]]);
  });
});

test('uncertain creation and execution are submitted once, including transient HTTP failures',async()=>{
  for(const name of ['plan_rehearsal','run_rehearsal']) {
    const input=name==='plan_rehearsal'?{goal:'test',application:{providers:['stripe']}}:{session_id:'vs_owned',run_id:'vr_exact'};
    for(const failure of ['network','http']) {
      await withFetch(()=>{if(failure==='network')throw new TypeError('connection dropped');return new Response('upstream unavailable',{status:503});},async calls=>{
        await assert.rejects(runRehearsalAction(name,input));assert.equal(calls.length,1);
      });
    }
  }
});

test('job retrieval uses its exact existing job and does not execute',async()=>{
  await withFetch(()=>json({status:'done',state:'unproven_unavailable',green_allowed:false}),async calls=>{
    const r=await runRehearsalAction('get_rehearsal',{job_id:'job_existing'});
    assert.match(calls[0].url,/jobs\/job_existing$/);assert.equal(calls[0].body,undefined);assert.equal(r.green_allowed,false);
    await assert.rejects(runRehearsalAction('get_rehearsal',{job_id:'job_existing',session_id:'vs_owned'}));
    await assert.rejects(runRehearsalAction('get_rehearsal',{session_id:'vs_owned'}));assert.equal(calls.length,1);
  });
});

test('all guided tools are registered with truthful annotations and routed by the real dispatcher',async()=>{
  const server=createServer();registerHandlers(server);
  const handler=server._requestHandlers.get('tools/call');
  for(const tool of rehearsalTools){assert.ok(!HOSTED_TOOL_NAMES.has(tool.name),'native pilot must not expand the hosted surface');const advertised=ALL_TOOLS.find(t=>t.name===tool.name);assert.ok(advertised);assert.equal(advertised.annotations.readOnlyHint,tool.name==='get_rehearsal');}
  await withFetch(()=>json({status:'failed',app_verified:false}),async calls=>{
    for(const name of ['run_rehearsal','get_rehearsal','stop_rehearsal']) {
      const res=await handler({method:'tools/call',params:{name,arguments:{session_id:'vs_owned',run_id:'vr_exact'}}},{});
      assert.notEqual(res.isError,true);assert.equal(JSON.parse(res.content[0].text).status,'failed');
    }
    const r=await handler({method:'tools/call',params:{name:'plan_rehearsal',arguments:{goal:'Verify my workflow'}}},{});
    assert.equal(JSON.parse(r.content[0].text).stage,'inspect_project');assert.equal(calls.length,3);
  });
});

test('concurrent guided calls retain request-local callers instead of process credentials',async()=>{
  await withFetch(async call=>{
    await new Promise(resolve=>setTimeout(resolve,call.body.run_id==='vr_a'?10:1));
    return json({session_id:call.body.session_id,run_id:call.body.run_id,status:'setup_blocked',ready:false,app_verified:false});
  },async calls=>{
    await Promise.all([
      withRequestIdentity({apiKey:'fsk_fake_guided_a',platform:'lovable'},()=>runRehearsalAction('get_rehearsal',{session_id:'vs_a',run_id:'vr_a'})),
      withRequestIdentity({apiKey:'fsk_fake_guided_b',platform:'replit'},()=>runRehearsalAction('get_rehearsal',{session_id:'vs_b',run_id:'vr_b'})),
      withRequestIdentity({apiKey:'',platform:'bolt'},()=>runRehearsalAction('get_rehearsal',{session_id:'vs_anon',run_id:'vr_anon'})),
    ]);
    const byRun=Object.fromEntries(calls.map(c=>[c.body.run_id,c.headers]));
    assert.equal(byRun.vr_a.authorization,'Bearer fsk_fake_guided_a');assert.equal(byRun.vr_a['x-mcp-client'],'lovable');
    assert.equal(byRun.vr_b.authorization,'Bearer fsk_fake_guided_b');assert.equal(byRun.vr_b['x-mcp-client'],'replit');
    assert.equal(byRun.vr_anon.authorization,undefined);assert.equal(byRun.vr_anon['x-mcp-client'],'bolt');
  });
});

test('dispatcher reports uncertain submissions without falsely saying it retried or asking for a second write',async()=>{
  const server=createServer();registerHandlers(server);const handler=server._requestHandlers.get('tools/call');
  await withFetch(()=>new Response('unavailable',{status:503}),async calls=>{
    const res=await handler({method:'tools/call',params:{name:'run_rehearsal',arguments:{session_id:'vs_owned',run_id:'vr_exact'}}},{});
    assert.equal(res.isError,true);assert.match(res.content[0].text,/not automatically resubmitted/);
    assert.doesNotMatch(res.content[0].text,/retried once|Try again in a minute/);assert.equal(calls.length,1);
  });
});

test('guided continuations translate reads only and preserve a native restart checkpoint',async()=>{
  await withFetch(()=>json({session_id:'vs_owned',run_id:'vr_exact',status:'running',client_checkpoint:{operation:'restart'},
    next_tool_call:{tool:'validate_integration',arguments:{session_id:'vs_owned',run_id:'vr_exact'}}}),async()=>{
    const r=await runRehearsalAction('get_rehearsal',{session_id:'vs_owned',run_id:'vr_exact'});
    assert.deepEqual(r.next_tool_call,{tool:'get_rehearsal',arguments:{session_id:'vs_owned',run_id:'vr_exact'}});
    assert.equal(r.client_checkpoint.operation,'restart');assert.equal(r.app_verified,false);
  });
  for(const action of ['execute','preflight','cancel'])await withFetch(()=>json({session_id:'vs_owned',run_id:'vr_exact',status:'setup_blocked',app_verified:false,
    next_tool_call:{tool:'validate_integration',arguments:{session_id:'vs_owned',run_id:'vr_exact',[action]:true}}}),async()=>{
    const r=await runRehearsalAction('get_rehearsal',{session_id:'vs_owned',run_id:'vr_exact'});
    assert.equal(r.next_tool_call.tool,'validate_integration');assert.equal(r.next_tool_call.arguments[action],true);
  });
});
