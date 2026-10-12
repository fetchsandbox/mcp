import { test } from "node:test";
import assert from "node:assert/strict";
import { runValidateIntegration, validateIntegrationTool } from "../dist/tools/validate_integration.js";

test("readiness reaches HTTP handler; exact run status stays pinned", async () => {
  const prior = globalThis.fetch;
  const calls=[];
  globalThis.fetch=async (url, options)=>{ calls.push({url,body:JSON.parse(options.body)}); return new Response(JSON.stringify({session_id:"vs_owned",run_id:"vr_exact",status:"setup_blocked",ready:false,next_action:"repair_setup_then_retry_same_preflight"}),{status:200,headers:{"content-type":"application/json"}}); };
  try {
    assert.ok(validateIntegrationTool.inputSchema.properties.preflight);
    const ready=await runValidateIntegration({session_id:"vs_owned",run_id:"vr_exact",preflight:true});
    assert.equal(ready.status,"setup_blocked");
    assert.equal(calls[0].body.preflight,true);
    assert.equal(calls[0].body.execute,false);
    await runValidateIntegration({session_id:"vs_owned",run_id:"vr_exact"});
    assert.equal(calls[1].body.run_id,"vr_exact");
    assert.equal(calls[1].body.execute,false);
    await assert.rejects(runValidateIntegration({session_id:"vs_owned",run_id:"vr_exact",preflight:true,execute:true}));
    assert.equal(calls.length,2);
  } finally { globalThis.fetch=prior; }
});

test("builder coverage review reaches the existing application contract unchanged", async () => {
  const prior = globalThis.fetch;
  const calls=[];
  const coverage = [{dimension:"duplicate_replay",relevance:"relevant",reason:"One purchase must grant access once",rule_ids:["replay"]}];
  globalThis.fetch=async (url, options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify({app_verified:false,step:"configure_app"}),{status:200,headers:{"content-type":"application/json"}});};
  try {
    const schema=validateIntegrationTool.inputSchema.properties.application_config.properties.coverage_review;
    assert.deepEqual(schema.items.required,["dimension","relevance","reason","rule_ids"]);
    assert.equal(schema.items.additionalProperties,false);
    const result=await runValidateIntegration({session_id:"vs_owned",suite:"application_workflow_v1",application_config:{app_version:"test-v1",disposable_test_app:true,checks:[],coverage_review:coverage}});
    assert.deepEqual(calls[0].application_config.coverage_review,coverage);
    assert.equal(calls.length,1);
    assert.equal(result.app_verified,false);
  } finally {globalThis.fetch=prior;}
});

test("native restart checkpoint preserves same run and never requests another execute", async () => {
  const prior=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async (_url,options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify({session_id:"vs_owned",run_id:"vr_exact",status:"running",client_checkpoint:{operation:"restart",check_id:"durability"},next_action:"perform_native_restart_then_retrieve_same_run"}),{status:200,headers:{"content-type":"application/json"}});};
  try {
    const result=await runValidateIntegration({session_id:"vs_owned",run_id:"vr_exact"});
    assert.equal(result.step,"native_restart_required");
    assert.equal(result.client_checkpoint.operation,"restart");
    assert.equal(result.next_action,"perform_native_restart_then_retrieve_same_run");
    assert.equal(result.app_verified,false);
    assert.ok(calls.every(c=>c.run_id==="vr_exact" && !c.execute));
    assert.match(result.message_for_user,/real app process restart/);
  } finally {globalThis.fetch=prior;}
});

test("bounded overlap reaches backend while invalid concurrency remains rejected", async () => {
 const prior=globalThis.fetch;let calls=[];
 globalThis.fetch=async (_url,options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify({run_id:'vr_configured'}),{status:200,headers:{'content-type':'application/json'}});};
 const observed={before:{path:'/testing/state',assertion:{select:'orders[*]',count:0,required:true}},observe:{path:'/testing/state'},assertion:{select:'orders[*]',count:1,required:true}};
 const config=(concurrency)=>({checks:[{...observed,id:'baseline',name:'Order saved',actions:[{method:'POST',path:'/orders'}]},{...observed,id:'replay',name:'One receipt after replay',actions:[{event:{provider:'stripe',replay_of:'{{step1.event_id}}'},concurrency}]}]});
 try {
   const result=await runValidateIntegration({session_id:'vs_owned',suite:'application_workflow_v1',application_config:config(3)});
   assert.equal(result.run_id,'vr_configured');assert.equal(calls.length,1);
   assert.equal(calls[0].application_config.checks[1].actions[0].concurrency,3);
   for(const value of [0,9,true,1.5,'2']) {
     const rejected=await runValidateIntegration({session_id:'vs_owned',suite:'application_workflow_v1',application_config:config(value)});
     assert.equal(rejected.configuration_accepted,false);assert.ok(rejected.validation_errors.some(e=>e.code==='signed_event_concurrency'));
   }
   assert.equal(calls.length,1);
 }finally{globalThis.fetch=prior;}
});
