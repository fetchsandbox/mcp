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
