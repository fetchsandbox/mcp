/** Bounded local reverse relay: no ngrok executable or shared account token. */
import http from 'node:http';
import net from 'node:net';
import { buildHeaders, getBaseUrl, postJsonLong, ToolError } from '../client.js';
import { isHosted } from '../request_context.js';
const MAX_BYTES=1024*1024;
// Local signed requests must bypass any global enterprise proxy.
const LOCAL_AGENT=new http.Agent({keepAlive:true});
const HEADER_ALLOW=new Set(['content-type','stripe-signature','paddle-signature','svix-id','svix-timestamp','svix-signature','authorization','idempotency-key','x-flow-run-id','user-agent','x-fetchsandbox-verifier-token']);
export const manageTunnelTool={name:'manage_tunnel',description:'Connect the actual local disposable test app to the FetchSandbox verifier, without installing ngrok or sharing an account token. Local stdio coding agents only; hosted builders use their published app origin. Steps: (1) inspect the real app, its provider clients, existing webhook handler route, signature verification and saved-state read-back; never invent a substitute webhook route or remove signature checks. (2) Start that app on a loopback port and call action=open,port. (3) Call validate_integration with providers and the returned app_base_url; retain session_id. (4) Inspect coverage_policy, propose application checks, prepare/read back fixtures, and configure suite=application_workflow_v1. Register the exact inspected webhook path in application_config.event_destinations, e.g. stripe:/stripe-webhook ONLY if that is the real handler. This declares where FetchSandbox sends provider-shaped signed events; it does not register a live-provider endpoint. Use provider-native event types/payloads and exact event-ID replay. (5) Use the native protected handoff: call install_test_credentials with session_id/run_id and inspected env_mapping; load its private dotenv file into the disposable app without reading or printing it. Configure temporary provider base URLs; preserve production configuration. The relay credential is internal and never goes to the app. (6) Preflight, execute ONCE, then poll the same session_id/run_id and retrieve its receipt. Independently assert order/state and receipt effects across replay, concurrent/stale/delayed events, invalid signatures and relevant provider failures, response loss and restart. HTTP 200 or connectivity alone is not proof; retain unsupported/unmeasured checks. Compare original buggy and fixed app versions under the same contract. (7) Close the tunnel and clean temporary settings. If local startup/connectivity fails, retain the blocker and use the existing Phalanx prove_fix fallback. This temporary address is verifier-only, not a public website. A disconnect or backend restart ends the lease; do not automatically replay uncertain writes.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['open','status','close']},port:{type:'integer',minimum:1024,maximum:65535}},required:['action'],additionalProperties:false}} as const;
interface Message{id:string;method:string;path:string;headers:Record<string,string>;body_b64:string;deadline_ms?:number}
interface Lease{tunnel_id:string;app_base_url:string;expires_in_seconds:number;transport:string}
interface Active{lease:Lease;port:number;stop:AbortController;expires:number}
let active:Active|undefined;
export function validateMessage(m:Message):void{
 if(!/^[a-f0-9]{32}$/.test(m.id)||!['GET','POST','PUT','PATCH','DELETE'].includes(m.method))throw new ToolError('Invalid relay request');
 if(typeof m.path!=='string'||!m.path.startsWith('/')||m.path.startsWith('//')||/[\\?#\r\n]/.test(m.path))throw new ToolError('Invalid relay path');
 const decoded=decodeURIComponent(m.path);
 if(decoded.startsWith('//')||/[\\?#\r\n]/.test(decoded)||decoded.split('/').some(p=>p==='.'||p==='..'))throw new ToolError('Invalid relay path');
 if(Object.entries(m.headers).some(([k,v])=>!HEADER_ALLOW.has(k.toLowerCase())||/[\r\n]/.test(v)))throw new ToolError('Invalid relay header');
 if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(m.body_b64)||Buffer.from(m.body_b64,'base64').length>MAX_BYTES)throw new ToolError('Invalid relay body');
}
export async function forwardLocal(port:number,m:Message):Promise<{status:number;headers:Record<string,string>;body_b64:string}>{
 validateMessage(m);
 return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,agent:LOCAL_AGENT,path:m.path,method:m.method,headers:m.headers,timeout:Math.max(1,Math.min(25000,(m.deadline_ms||Date.now()+25000)-Date.now()))},res=>{
   const chunks:Buffer[]=[];let size=0;
   res.on('data',(b:Buffer)=>{size+=b.length;if(size>MAX_BYTES){res.destroy();reject(new ToolError('Local response exceeds relay limit'));}else chunks.push(b);});
   res.on('error',reject);res.on('end',()=>{const headers:Record<string,string>={};for(const k of ['content-type','retry-after']){const v=res.headers[k];if(typeof v==='string')headers[k]=v;}resolve({status:res.statusCode||502,headers,body_b64:Buffer.concat(chunks).toString('base64')});});
  });
  req.on('timeout',()=>req.destroy(new Error('Local app request timed out')));req.on('error',reject);req.end(Buffer.from(m.body_b64,'base64'));
 });
}
async function control(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<any>{
 const ctrl=new AbortController();const abort=()=>ctrl.abort();
 const timer=setTimeout(abort,20000);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 try{
  const res=await fetch(getBaseUrl()+path,{method,headers:buildHeaders(body?{'content-type':'application/json'}:undefined),body:body?JSON.stringify(body):undefined,signal:ctrl.signal,redirect:'error'});
  if(!res.ok)throw new ToolError(`Managed tunnel ${method} failed (HTTP ${res.status})`,res.status);return await res.json();
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

async function poll(a:Active):Promise<void>{
 const pending=new Set<Promise<void>>();
 try{while(!a.stop.signal.aborted&&Date.now()<a.expires){
  const result=await control(`/api/mcp/tunnels/${a.lease.tunnel_id}/poll`,'GET',undefined,a.stop.signal);
  for(const m of result.requests||[]){
   if(typeof m.deadline_ms!=="number"||Date.now()>=m.deadline_ms)continue;
   if(pending.size>=16)throw new ToolError('Relay capacity exceeded');
   const task=(async()=>{let reply;try{reply=await forwardLocal(a.port,m);}catch{reply={status:502,headers:{'content-type':'application/json'},body_b64:Buffer.from('{"error":"local_app_unavailable"}').toString('base64')};}
    try{await control(`/api/mcp/tunnels/${a.lease.tunnel_id}/reply`,'POST',{request_id:m.id,...reply});}catch{/* No replay of an uncertain application request. */}
   })();pending.add(task);void task.finally(()=>pending.delete(task));
  }
 }}catch{/* Disconnect stays visible; no silent repeat. */}finally{a.stop.abort();if(active===a)active=undefined;try{await control(`/api/mcp/tunnels/${a.lease.tunnel_id}`,'DELETE');}catch{/* bounded server expiry */}}
}
export async function runManageTunnel(input:{action:string;port?:number}):Promise<unknown>{
 if(isHosted())throw new ToolError('Use the local MCP package for managed tunnels; hosted builders use their published URL');
 if(input.action==='close'){if(!active)return {closed:true};const a=active;active=undefined;a.stop.abort();try{await control(`/api/mcp/tunnels/${a.lease.tunnel_id}`,'DELETE');}catch(e){if(!(e instanceof ToolError&&[404,410].includes(e.status||0)))throw e;}return {closed:true};}
 if(input.action==='status')return active?control(`/api/mcp/tunnels/${active.lease.tunnel_id}/status`):{active:false};
 if(input.action!=='open'||!Number.isInteger(input.port)||input.port!<1024||input.port!>65535)throw new ToolError('Specify the running app port (1024–65535)');
 if(active)throw new ToolError('Close the current tunnel before opening another');
 await new Promise<void>((resolve,reject)=>{const s=net.connect({host:'127.0.0.1',port:input.port!});s.setTimeout(3000);s.once('connect',()=>{s.destroy();resolve();});s.once('error',()=>reject(new ToolError('Local app is not listening; start it first, or use Phalanx')));s.once('timeout',()=>{s.destroy();reject(new ToolError('Local app readiness timed out'));});});
 let lease:Lease;
 try{lease=await postJsonLong<Lease>('/api/mcp/tunnels',{},20000);}catch(e){if(e instanceof ToolError&&e.status)throw e;throw new ToolError('Cannot connect to FetchSandbox over HTTPS. Check network/VPN/proxy and certificate settings. No verification ran; use Phalanx only if that backend connection is available.');}
 if(!/^[a-f0-9]{48}$/.test(lease.tunnel_id)||lease.expires_in_seconds<60||lease.expires_in_seconds>1800)throw new ToolError('Invalid managed tunnel lease');
 const a:Active={lease,port:input.port!,stop:new AbortController(),expires:Date.now()+lease.expires_in_seconds*1000};active=a;void poll(a);
 return {...lease,proof_status:'not_tested',next:'Pass app_base_url to validate_integration. Configure application_workflow_v1, execute before/after with signed-event and state assertions, retrieve the receipt, then close this tunnel.'};
}
