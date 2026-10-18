import {test} from "node:test";
import assert from "node:assert/strict";
import {runValidateIntegration, validateIntegrationTool} from "../dist/tools/validate_integration.js";

const event = {provider:"paddle",type:"transaction.completed",payload:{id:"{{step1.transactionId}}",status:"completed"}};
const baseline = {id:"baseline",name:"Pending order saved",actions:[{method:"POST",path:"/api/testing/orders",body:{run_id:"{{run_id}}"}}],before:{path:"/api/testing/state/{{run_id}}",assertion:{select:"orders[*]",count:0,required:true}},observe:{path:"/api/testing/state/{{run_id}}"},assertion:{select:"orders[*]",count:1,required:true}};
const purchase = {...baseline,id:"paid",name:"Signed payment grants access",actions:[{event,expect_status:200}]};
const input = (checks) => ({session_id:"vs_owned",suite:"application_workflow_v1",application_config:{app_version:"test-v1",disposable_test_app:true,require_verifier_token:true,event_destinations:{paddle:"/api/store/webhooks/paddle"},checks}});

test("captured routed signed action produces actionable diagnostics without backend calls",async()=>{
  const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error("Rejected authoring must not contact backend");};
  try {
    for (const method of ["POST","EVENT"]) {
      const rejected=await runValidateIntegration(input([baseline,{...purchase,actions:[{event,expect_status:200,method,path:"/api/store/webhooks/paddle"}]}]));
      assert.equal(rejected.status,"configuration_rejected");
      assert.equal(rejected.app_verified,false);
      assert.equal(rejected.configuration_accepted,false);
      assert.equal(rejected.next_tool_call,null);
      assert.deepEqual(rejected.validation_errors.map(e=>[e.path,e.code]),[["application_config.checks[1].actions[0]","signed_event_action_fields"]]);
      assert.match(rejected.validation_errors[0].message,/event_destinations/);
    }
    assert.equal(calls,0);
  } finally {globalThis.fetch=previous;}
});

test("query observation and signed baseline identify separate locations without exposing query values",async()=>{
  const previous=globalThis.fetch;globalThis.fetch=async()=>{throw new Error("No request allowed");};
  try {
    const rejected=await runValidateIntegration(input([{...baseline,observe:{path:"/api/testing/state?run_id=private-query-value"},actions:[...baseline.actions,{event,expect_status:200}]}]));
    assert.deepEqual(rejected.validation_errors.map(e=>[e.path,e.code]),[
      ["application_config.checks[0].observe.path","query_or_fragment_not_supported"],
      ["application_config.checks[0].actions[1]","baseline_signed_event"],
    ]);
    assert.match(rejected.validation_errors[0].message,/do not drop its scope filter/);
    assert.ok(!JSON.stringify(rejected).includes("private-query-value"));
  } finally {globalThis.fetch=previous;}
});

test("valid ordinary baseline, signed payment and exact replay reach backend unchanged",async()=>{
  const previous=globalThis.fetch;const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify({app_verified:false,step:"configure_app"}),{status:200,headers:{"content-type":"application/json"}});};
  try {
    const request=input([baseline,purchase,{...purchase,id:"replay",actions:[{event:{provider:"paddle",replay_of:"{{step2.event_id}}"},expect_status:200}]}]);
    const frozen=JSON.stringify(request);
    const response=await runValidateIntegration(request);
    assert.equal(response.app_verified,false);
    assert.equal(calls.length,1);
    assert.equal(calls[0].execute,false);
    assert.deepEqual(calls[0].application_config,request.application_config);
    assert.equal(JSON.stringify(request),frozen);
  } finally {globalThis.fetch=previous;}
});

test("replacement payload on exact replay is rejected rather than silently rewritten",async()=>{
  const previous=globalThis.fetch;globalThis.fetch=async()=>{throw new Error("No request allowed");};
  try {
    const rejected=await runValidateIntegration(input([baseline,{...purchase,actions:[{event:{provider:"paddle",replay_of:"{{step2.event_id}}",payload:{id:"different"}},expect_status:200}]}]));
    assert.equal(rejected.validation_errors[0].code,"signed_event_replay_fields");
  } finally {globalThis.fetch=previous;}
});

test("served metadata distinguishes action variants, baseline and path restrictions",()=>{
  const schema=validateIntegrationTool.inputSchema.properties.application_config;
  assert.match(schema.description,/ordinary HTTP actions/);
  assert.match(schema.description,/without query strings or fragments/);
  assert.match(schema.properties.event_destinations.description,/No method\/path\/body\/headers/);
  assert.match(validateIntegrationTool.description,/configuration_rejected/);
});

test("native Codex field guesses get exact repair guidance without creating an attempt",async()=>{
  const previous=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('No backend calls for invalid authoring');};
  try {
    const captured={...baseline,assertions:[baseline.assertion],observe:{method:'GET',path:'/orders/{{step1.id}}'}};
    delete captured.assertion;delete captured.before;
    const frozen=JSON.stringify(captured);
    const rejected=await runValidateIntegration(input([captured]));
    assert.equal(rejected.app_verified,false);
    assert.equal(rejected.validation_errors[0].code,'application_check_fields');
    assert.match(rejected.validation_errors[0].message,/assertion:\{all_of/);
    assert.match(rejected.validation_errors[0].message,/do not invent/i);
    assert.equal(JSON.stringify(captured),frozen);
    const missing=await runValidateIntegration(input([{...baseline,before:[],observe:{method:'GET',path:'/orders'}}]));
    assert.deepEqual(missing.validation_errors.map(e=>e.code),['application_check_object','application_observe_fields']);
    assert.match(missing.validation_errors[0].message,/protected read-only adapter.*actual state/);
    assert.equal(calls,0);
  } finally {globalThis.fetch=previous;}
});


test("incomplete app result keeps the pending work and failing verdict through MCP", async () => {
  const previous = globalThis.fetch;
  const continuation = {required:true, continue_in_current_agent:true, preserve_check_ids:["baseline","restart","duplicate"], pending_checks:[{check_id:"restart",status:"unmeasured"},{check_id:"duplicate",status:"violated"}]};
  globalThis.fetch = async () => new Response(JSON.stringify({suite:"application_workflow_v1", verdict:"failing", app_verified:false, complete:false, checks:[{id:"baseline",status:"held"},{id:"restart",status:"unmeasured"},{id:"duplicate",status:"violated"}], verification_continuation:continuation, manifest:{}, evidence:{trace:[]}}), {status:200,headers:{"content-type":"application/json"}});
  try {
    const result = await runValidateIntegration({session_id:"vs_test",run_id:"vr_test"});
    assert.deepEqual(result.verification_continuation,continuation);
    assert.equal(result.verdict,"failing");
    assert.equal(result.app_verified,false);
    assert.equal(result.checks.length,3);
  } finally {globalThis.fetch=previous;}
});

test('qualified requester input and provider observations reach the backend unchanged',async()=>{
  const previous=globalThis.fetch;const calls=[];
  globalThis.fetch=async(_url,options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify({run_id:'vr_contract',app_verified:false}),{status:200,headers:{'content-type':'application/json'}});};
  try {
    const check={...baseline,id:'requester_reply',actions:[baseline.actions[0],{provider_input:{provider:'zendesk',method:'PUT',path:'/api/v2/tickets/2001.json',body:{ticket:{comment:{body:'2',public:true,author_id:1001}}}}}],provider_assertions:[{provider:'zendesk',collection:'simulated_email_deliveries',assertion:{select:'records[*]',count:1,required:true}}]};
    const request=input([baseline,check]);
    const response=await runValidateIntegration(request);
    assert.notEqual(response.status,'configuration_rejected');assert.equal(calls.length,1);
    assert.deepEqual(calls[0].application_config,request.application_config);
  } finally {globalThis.fetch=previous;}
});
