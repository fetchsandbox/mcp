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
