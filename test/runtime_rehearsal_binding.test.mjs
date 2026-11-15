import test from 'node:test';
import assert from 'node:assert/strict';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
import {validateIntegrationTool,runValidateIntegration} from '../dist/tools/validate_integration.js';

test('runtime binding is exposed on the actual MCP contract and reaches the existing endpoint',async()=>{
 const binding={execution_id:'lead-a',workflow_version:'code-v1',contract_digest:'a'.repeat(64),input_digest:'b'.repeat(64),config_digest:'c'.repeat(64),state_digest:'d'.repeat(64)};
 const validate=new AjvJsonSchemaValidator().getValidator(validateIntegrationTool.inputSchema.properties.application_config.properties.execution_binding);
 assert.equal(validate(binding).valid,true);
 assert.equal(validate({...binding,input_digest:'not-a-digest'}).valid,false);
 assert.equal(validate({...binding,secret:'no'}).valid,false);
 const previous=globalThis.fetch;const calls=[];
 globalThis.fetch=async(_url,opts)=>{calls.push(JSON.parse(opts.body));return new Response(JSON.stringify({run_id:'fixture-run'}),{status:200,headers:{'content-type':'application/json'}});};
 try{
  await runValidateIntegration({session_id:'vs_owned',suite:'application_workflow_v1',application_config:{app_version:'code-v1',disposable_test_app:true,checks:[],execution_binding:binding}});
  assert.deepEqual(calls[0].application_config.execution_binding,binding);
 }finally{globalThis.fetch=previous;}
});
