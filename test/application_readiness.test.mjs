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
