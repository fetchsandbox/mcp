/**
 * The three-hop whitelist, pinned.
 *
 * prove_fix's result crosses three places that each name their fields
 * explicitly: the backend response dict, the client's return statement, and the
 * client's return TYPE. Miss any one and the field vanishes with no error.
 *
 * That is not hypothetical. `next_actions` was lost this way for weeks, and
 * `agent_guidance` — the instruction that stops an agent reporting its own
 * ungated harness as proof — was lost at the client from the day it was
 * written until 2026-09-12.
 *
 * The response below is built from the backend's own literal dict in
 * app/api/mcp.py, not from what this client hopes to receive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/tools/prove_fix.ts", import.meta.url), "utf8");

// Exactly the keys app/api/mcp.py puts on a done prove_fix job.
const BACKEND_FIELDS = [
  "green_allowed", "state", "reproduced", "verified", "reason",
  "cannot_run", "agent_guidance", "scenario", "receipt_url", "engine",
  "message_for_user", "stub_backed", "stub_backed_note",
];

test("every field the backend sends is named in the client's return", () => {
  const body = src.slice(src.indexOf("return {", src.indexOf("runProveFix")));
  for (const f of BACKEND_FIELDS) {
    assert.ok(new RegExp(`\\b${f}:`).test(body), `${f} is dropped by the client's return`);
  }
});

test("and declared in the return type, or tsc drops it anyway", () => {
  const type = src.slice(src.indexOf("Promise<{"), src.indexOf("}> {"));
  for (const f of BACKEND_FIELDS) {
    if (f === "engine" || f === "green_allowed") continue; // required, not optional
    assert.ok(new RegExp(`\\b${f}\\?:`).test(type), `${f} is missing from the return type`);
  }
});

test("the reason a developer can act on is carried, not just logged", () => {
  assert.ok(/cannot_run/.test(src), "cannot_run must survive to the client");
});

test('the executed client preserves the recorded caveat after a completed proof',async()=>{
  const {createServer}=await import('node:http');
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {runProveFix}=await import('../dist/tools/prove_fix.js');
  const dir=mkdtempSync(join(tmpdir(),'fs-proof-scope-'));
  writeFileSync(join(dir,'main.py'),'print(1)\n');
  const note='Recorded substitute dependency scope.';
  const srv=createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.method==='POST'?{job_id:'scope-test',status:'running'}:{status:'done',state:'proven',green_allowed:true,stub_backed:true,stub_backed_note:note}));
  });
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const names=['FETCHSANDBOX_BASE_URL','FETCHSANDBOX_WORKSPACE_ROOT','FETCHSANDBOX_API_KEY'];
  const old=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  Object.assign(process.env,{FETCHSANDBOX_BASE_URL:`http://127.0.0.1:${srv.address().port}`,FETCHSANDBOX_WORKSPACE_ROOT:dir,FETCHSANDBOX_API_KEY:'fsk_scope_test_not_real'});
  try{
    const result=await runProveFix({path:dir,diff:'--- a/main.py\n+++ b/main.py\n@@ -1 +1 @@\n-print(1)\n+print(2)\n'});
    assert.equal(result.green_allowed,true);assert.equal(result.stub_backed,true);assert.equal(result.stub_backed_note,note);
  }finally{
    await new Promise(r=>srv.close(r));rmSync(dir,{recursive:true,force:true});
    for(const k of names){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}
  }
});
