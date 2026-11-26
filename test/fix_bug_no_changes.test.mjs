import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runFixBug} from '../dist/tools/fix_bug.js';

// Legacy response observed in the native p1_support run. A no-patch result
// remains unavailable, even though its background callable returned normally.
test('no-change remediation returns a bounded next step without resubmitting',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fs-no-change-'));writeFileSync(join(dir,'app.js'),'export const count = 2;\n');
 const prior=globalThis.fetch,priorRoot=process.env.FETCHSANDBOX_WORKSPACE_ROOT;let starts=0,polls=0;
 process.env.FETCHSANDBOX_WORKSPACE_ROOT=dir;
 globalThis.fetch=async(_url,opts)=>{
  const body=opts.method==='POST'?(starts++,{status:'running',job_id:'no_change_job'}):
   (polls++,{status:'done',available:false,diff:null,summary:null,engine:'fetchsandbox',error:'subprocess produced no changes'});
  return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
 };
 try {
  const out=await runFixBug({bug:'Duplicate count',path:dir});
  assert.equal(out.available,false);assert.equal(out.diff,null);assert.equal(out.failure_kind,'no_changes');
  assert.equal(out.next_action,'review_finding_and_propose_patch');assert.match(out.agent_guidance,/Do not repeat/);
  assert.equal(starts,1);assert.equal(polls,1);
 }finally{globalThis.fetch=prior;if(priorRoot===undefined)delete process.env.FETCHSANDBOX_WORKSPACE_ROOT;else process.env.FETCHSANDBOX_WORKSPACE_ROOT=priorRoot;rmSync(dir,{recursive:true,force:true});}
});

test('an available flag cannot turn an empty diff into a proposed fix',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fs-empty-diff-'));writeFileSync(join(dir,'app.js'),'export const count = 2;\n');
 const prior=globalThis.fetch,priorRoot=process.env.FETCHSANDBOX_WORKSPACE_ROOT;
 process.env.FETCHSANDBOX_WORKSPACE_ROOT=dir;
 globalThis.fetch=async(_url,opts)=>new Response(JSON.stringify(opts.method==='POST'
  ? {status:'running',job_id:'empty_diff_job'}
  : {status:'done',available:true,diff:'  ',summary:'Done'}),{status:200,headers:{'content-type':'application/json'}});
 try {
  const out=await runFixBug({bug:'Duplicate count',path:dir});
  assert.equal(out.available,false);assert.equal(out.diff,null);assert.equal(out.failure_kind,'no_changes');
 }finally{globalThis.fetch=prior;if(priorRoot===undefined)delete process.env.FETCHSANDBOX_WORKSPACE_ROOT;else process.env.FETCHSANDBOX_WORKSPACE_ROOT=priorRoot;rmSync(dir,{recursive:true,force:true});}
});
