import test from 'node:test';
import assert from 'node:assert/strict';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
import {validateIntegrationTool} from '../dist/tools/validate_integration.js';

const validate = new AjvJsonSchemaValidator().getValidator(validateIntegrationTool.inputSchema);
const baseline = {
  id:'baseline', name:'Order saved',
  before:{path:'/testing/state/{{run_id}}',assertion:{select:'orders[*]',count:0,required:true}},
  actions:[{method:'POST',path:'/orders',body:{sku:'mug',quantity:1}}],
  observe:{path:'/testing/state/{{run_id}}'},
  assertion:{select:'orders[*]',count:1,required:true},
};
const input = checks => ({session_id:'vs_owned',suite:'application_workflow_v1',application_config:{app_version:'original',disposable_test_app:true,checks}});

test('published contract schema rejects the malformed shapes observed in native Codex',()=>{
  for (const check of [
    {...baseline,assertions:[baseline.assertion],assertion:undefined},
    {...baseline,action:baseline.actions[0],actions:undefined},
    {...baseline,assert:baseline.assertion,assertion:undefined},
    {...baseline,before:[]},
    {...baseline,observe:{method:'GET',path:'/orders'}},
  ]) assert.equal(validate(input([check])).valid,false);
});

test('schema accepts normal, fault, replay, restart and explicit unsupported checks',()=>{
  const request=input([
    baseline,
    {...baseline,id:'rate',fault:{provider:'stripe',scenario:'rate_limit',evidence:'refusal'}},
    {...baseline,id:'replay',actions:[{event:{provider:'stripe',replay_of:'{{step2.event_id}}'},concurrency:2}],assertion:{all_of:[{select:'orders[*]',count:1,required:true},{select:'orders[*]',where:[{select:'paid',equals:true,required:true}],count:1,required:true}]}},
    {...baseline,id:'restart',actions:[{client_lifecycle:{operation:'restart',observe_path:'/testing/runtime',identity_field:'instance_id',timeout_seconds:30}}]},
    {id:'browser',name:'Browser checkout',unsupported_reason:'No browser adapter in this contract'},
  ]);
  request.application_config.event_delivery='provider_lifecycle';
  const frozen=JSON.stringify(request);
  assert.equal(validate(request).valid,true);
  assert.equal(JSON.stringify(request),frozen);
  request.application_config.checks[2].actions[0].concurrency=9;
  assert.equal(validate(request).valid,false);
});

test('client-level response loss is distinct from failed-callback recovery',()=>{
  for(const evidence of ['accepted_response_retry','accepted_response_loss']) {
    assert.equal(validate(input([baseline,{...baseline,id:'loss',fault:{provider:'resend',scenario:'accepted_response_loss',evidence}}])).valid,true);
  }
  assert.match(validateIntegrationTool.description,/observed client disconnect/);
});

test('schema exposes bounded HTTP overlap without accepting mixed event actions',()=>{
  const check={...baseline,actions:[{...baseline.actions[0],concurrency:2}]};
  assert.equal(validate(input([baseline,{...check,id:'parallel'}])).valid,true);
  for(const concurrency of [0,9,true,1.5,'2']) {
    check.actions[0].concurrency=concurrency;
    assert.equal(validate(input([baseline,{...check,id:'parallel'}])).valid,false);
  }
  assert.match(validateIntegrationTool.description,/step1.results.0.id/);
});

test('workflow lifecycle selection carries catalog ids without allowing invented profile objects',()=>{
  const request=input([baseline]);
  request.application_config.event_delivery='provider_lifecycle';
  request.application_config.event_destinations={stripe:'/stripe-webhook'};
  request.application_config.provider_lifecycle_workflows={stripe:'create_and_send_invoice'};
  assert.equal(validate(request).valid,true);
  request.application_config.provider_lifecycle_workflows.stripe={witness_events:['made.up']};
  assert.equal(validate(request).valid,false);
});

test('scope reassessment exposes exclusions separately from typed pending work',()=>{
  const blocked={id:'ordering',name:'Older event keeps current state',blocker:{category:'observation_missing',reason:'Missing saved-state observer',evidence:['app.py: route inspection']}};
  const request=input([baseline,blocked,{id:'refund',name:'Refund',unsupported_reason:'Not a promised shop feature'}]);
  request.application_config.scope_review=request.application_config.checks.map(c=>({check_id:c.id,classification:c.id==='refund'?'outside_app_scope':'in_scope',reason:'Inspected app behavior',evidence:['app.py: route inspection']}));
  assert.equal(validate(request).valid,true);
  blocked.blocker.category='outside_app_scope';
  assert.equal(validate(request).valid,false);
  blocked.blocker.category='engine_unsupported';blocked.blocker.capability='invented';
  assert.equal(validate(request).valid,false);
});

test('fixture discovery stays in the existing authenticated MCP session',()=>{
  for(const inspect of [
    {provider:'paddle',resource:'state'},
    {provider:'paddle',resource:'state',collection:'transactions',limit:20,offset:0},
    {provider:'paddle',resource:'operations',method:'POST',path:'/transactions'},
  ]) assert.equal(validate({session_id:'vs_owned',inspect}).valid,true);
  assert.equal(validate({session_id:'vs_owned',inspect:{provider:'paddle',resource:'state',limit:101}}).valid,false);
  assert.equal(validate({session_id:'vs_owned',inspect:{provider:'paddle',resource:'state',sandbox_id:'someone_else'}}).valid,false);
});

test('provider evidence and requester input retain distinct typed contracts',()=>{
  const check={...baseline,id:'customer_reply',actions:[baseline.actions[0],{provider_input:{provider:'zendesk',method:'PUT',path:'/api/v2/tickets/2001.json',body:{ticket:{comment:{body:'2',public:true,author_id:1001}}}}}],provider_assertions:[{provider:'zendesk',collection:'simulated_email_deliveries',assertion:{select:'records[*]',count:1,required:true}}]};
  assert.equal(validate(input([baseline,check])).valid,true);
  check.actions[1].provider_input.provider='zendesk';check.actions[1].method='PUT';
  assert.equal(validate(input([baseline,check])).valid,false,'provider input cannot masquerade as an app request');
  delete check.actions[1].method;
  check.provider_assertions[0].unexpected='unsafe';
  assert.equal(validate(input([baseline,check])).valid,false);
});

test('external operator input is explicit and preserves ordinary application actions',()=>{
  const check={...baseline,id:'operator_race',actions:[baseline.actions[0],{provider_input:{actor:'external_operator',provider:'stripe',method:'POST',path:'/v1/refunds',body:{charge:'ch_fixture'}}},baseline.actions[0]]};
  assert.equal(validate(input([baseline,check])).valid,true);
  check.actions[1].provider_input.actor='pretend_app';
  assert.equal(validate(input([baseline,check])).valid,false);
});

test('isolated application clock controls have one explicit bounded schema',()=>{
  const request=input([baseline,{...baseline,id:'expiry',actions:[{advance_time:604800}]}]);
  request.application_config.require_verifier_token=true;
  request.application_config.application_clock={advance_path:'/verify/clock/advance',observe_path:'/verify/clock'};
  assert.equal(validate(request).valid,true);
  for(const value of [-1,0,true,'604800',31622401]) {
    request.application_config.checks[1].actions[0].advance_time=value;
    assert.equal(validate(request).valid,false);
  }
  request.application_config.checks[1].actions[0]={advance_time:60,method:'POST',path:'/extra'};
  assert.equal(validate(request).valid,false);
});

test('received fixtures are explicit inputs and fit a separate bounded control allowance',()=>{
  const fixture={provider_input:{actor:'fixture',provider:'gmail',method:'POST',path:'/__fetchsandbox/fixtures/record',body:{resource:'messages',profile:'received_message',record:{id:'received'}}}};
  const check={...baseline,actions:[...Array.from({length:20},()=>baseline.actions[0]),...Array.from({length:8},()=>fixture)]};
  assert.equal(validate(input([check])).valid,true);
  check.actions.push(fixture);
  assert.equal(validate(input([check])).valid,false);
  check.actions=[baseline.actions[0],{...fixture,method:'POST'}];
  assert.equal(validate(input([check])).valid,false,'a fixture cannot masquerade as an application request');
});

test('controlled fixture transitions use the existing input action and exact replay schema',()=>{
  const request=input([baseline,{...baseline,id:'status-order',actions:[
    baseline.actions[0],
    {provider_input:{provider:'whatsapp-cloud',actor:'fixture',method:'POST',path:'/__fetchsandbox/fixtures/transition',body:{resource:'messages',id:'{{step1.wamid}}',status:'read',delivery_delay_seconds:1}}},
    {event:{provider:'whatsapp-cloud',replay_of:'{{step2.event_id}}'},concurrency:2},
  ]}]);
  request.application_config.event_destinations={'whatsapp-cloud':'/whatsapp-event'};
  assert.equal(validate(request).valid,true);
  const actionSchema=validateIntegrationTool.inputSchema.properties.application_config.properties.checks.items.oneOf.find(branch=>branch.properties?.actions).properties.actions;
  assert.match(JSON.stringify(actionSchema),/fixtures\/transition/);
  assert.match(JSON.stringify(actionSchema),/synthetic lifecycle evidence/);
});

test('inspection schema separates operation lookup from paginated state',()=>{
  for (const inspect of [
    {provider:'paddle',resource:'operations'},
    {provider:'paddle',resource:'operations',method:'GET',path:'/transactions'},
    {provider:'stripe',resource:'state',collection:'customers',offset:0,limit:1},
  ]) assert.equal(validate({session_id:'vs_owned',inspect}).valid,true);
  for (const inspect of [
    {provider:'paddle',resource:'operations',path:'/transactions',limit:20},
    {provider:'paddle',resource:'operations',limit:20},
    {provider:'paddle',resource:'operations',collection:'transactions'},
    {provider:'paddle',resource:'operations',path:'/transactions'},
    {provider:'paddle',resource:'operations',method:'GET'},
    {provider:'paddle',resource:'state',method:'GET',path:'/transactions'},
  ]) assert.equal(validate({session_id:'vs_owned',inspect}).valid,false,JSON.stringify(inspect));
});
