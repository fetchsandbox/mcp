import test from 'node:test';
import assert from 'node:assert/strict';
import {runValidateIntegration} from '../dist/tools/validate_integration.js';

test('planning submits once through existing job transport and returns the proposed plan',async()=>{
  const previous=globalThis.fetch; const calls=[];
  globalThis.fetch=async(url,options)=>{
    calls.push({url,body:options.body && JSON.parse(options.body)});
    return new Response(JSON.stringify(options.method==='POST'
      ? {status:'running',job_id:'owned_planning_job'}
      : {status:'done',step:'planning',app_verified:false,verification_plan:{rules:[{id:'A1',status:'unmeasured'}]}}),
      {status:200,headers:{'content-type':'application/json'}});
  };
  try {
    const result=await runValidateIntegration({session_id:'vs_owned',application_context:{goal:'Inspect checkout'}});
    assert.equal(calls.filter(c=>c.body).length,1);
    assert.equal(calls[0].body.async_job,true);
    assert.match(calls[1].url,/jobs\/owned_planning_job$/);
    assert.equal(result.app_verified,false);
    assert.equal(result.verification_plan.rules[0].status,'unmeasured');
  } finally {globalThis.fetch=previous;}
});


test('fixture inspection forwards through the existing endpoint without planning or writes',async()=>{
  const previous=globalThis.fetch; const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({step:'inspect',app_verified:false,records:[{id:'txn_actual'}]}),{status:200,headers:{'content-type':'application/json'}});};
  try{
    const inspect={provider:'paddle',resource:'state',collection:'transactions',limit:20};
    const result=await runValidateIntegration({session_id:'vs_owned',inspect});
    assert.equal(calls.length,1);assert.deepEqual(calls[0].body.inspect,inspect);
    assert.equal(calls[0].body.async_job,false);assert.equal(calls[0].body.fixtures,null);
    assert.equal(result.app_verified,false);assert.equal(result.records[0].id,'txn_actual');
  }finally{globalThis.fetch=previous;}
});

test('invalid inspection returns an actionable repair without sending an HTTP request',async()=>{
 const previous=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error('invalid inspection reached HTTP');};
 try {
  const result=await runValidateIntegration({session_id:'vs_owned',inspect:{provider:'paddle',resource:'operations',path:'/transactions',limit:20}});
  assert.equal(calls,0);assert.equal(result.status,'inspection_rejected');assert.equal(result.app_verified,false);
  assert.equal(result.next_action,'repair_inspection');
  assert.ok(result.validation_errors.some(x=>x.code==='operations_state_pagination'));
  assert.ok(result.validation_errors.some(x=>x.code==='operation_method_path_pair'));
  assert.equal(result.session_id,'vs_owned');
 }finally{globalThis.fetch=previous;}
});

test('captured missing provider is repaired locally without guessing or creating a session',async()=>{
 const previous=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error('No backend request for incomplete inspection');};
 try {
  const result=await runValidateIntegration({session_id:'vs_owned',inspect:{resource:'state'}});
  assert.equal(calls,0);assert.equal(result.status,'inspection_rejected');
  assert.equal(result.app_verified,false);assert.equal(result.session_id,'vs_owned');
  assert.ok(result.validation_errors.some(e=>e.code==='inspection_provider_required'));
 }finally{globalThis.fetch=previous;}
});
