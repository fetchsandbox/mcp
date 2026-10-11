/** Owner-only credentials never enter MCP tool output or project source files. */
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { postJsonLong, ToolError } from '../client.js';
import { isHosted } from '../request_context.js';
export const installTestCredentialsTool = {
 name: 'install_test_credentials',
 description: 'Local coding agents only: after validate_integration configures an owned run, install its temporary twin API keys, webhook signing secrets and verifier token privately. Uses your existing FetchSandbox MCP account key; no browser sign-in or secret values in chat. Returns a private dotenv file path and variable names ONLY. Supply env_mapping from returned required_secret_names to the inspected app setting names, e.g. FETCHSANDBOX_STRIPE_WEBHOOK_SECRET:STRIPE_WEBHOOK_SECRET. Never invent secrets or remove signature checks. Start/restart ONLY the disposable test app with this file using its dotenv loader; never cat/read/print it or paste values into a prompt, source, logs or shell arguments. Twin base URLs come from validate_integration and must also be configured. Preserve existing production configuration. Then preflight and execute once, retrieve the same run receipt, and delete this temporary file after testing. Hosted Replit/Lovable use their existing protected browser handoff and native secret manager.',
 inputSchema: {type:'object',properties:{session_id:{type:'string'},run_id:{type:'string'},env_mapping:{type:'object',additionalProperties:{type:'string'},description:'Temporary handoff variable name to actual app environment variable name; unspecified names are preserved.'}},required:['session_id','run_id'],additionalProperties:false}
} as const;
export async function saveCredentialFile(secrets:{name:string;value:string}[], mapping:Record<string,string>={}, root=path.join(os.homedir(),'.fetchsandbox','handoffs')) {
 const names=new Set<string>(); const lines:string[]=[];
 if(!Array.isArray(secrets)||!secrets.length||secrets.length>40)throw new ToolError('Invalid credential handoff');
 if(Object.keys(mapping).some(k=>!secrets.some(s=>s.name===k)))throw new ToolError('Mapping contains an unknown handoff variable');
 for(const item of secrets){
  const name=mapping[item.name]??item.name;
  if(!/^[A-Z][A-Z0-9_]{0,99}$/.test(item.name)||!/^[A-Z][A-Z0-9_]{0,99}$/.test(name)||names.has(name)||typeof item.value!=='string'||!item.value||! /^[A-Za-z0-9_./+=:@-]+$/.test(item.value)||item.value.length>4096)throw new ToolError('Invalid credential mapping or format');
  names.add(name);lines.push(`${name}=${item.value}`);
 }
 const absolute=path.resolve(root); let current=path.parse(absolute).root;
 for(const part of absolute.slice(current.length).split(path.sep).filter(Boolean)){
  current=path.join(current,part);
  try {const stat=await fs.lstat(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw new ToolError('Unsafe credential directory');}
  catch(e:any){if(e.code!=='ENOENT')throw e;await fs.mkdir(current,{mode:0o700});}
 }
 await fs.chmod(absolute,0o700);
 const dir=await fs.mkdtemp(path.join(absolute,'run-'));await fs.chmod(dir,0o700);
 const file=path.join(dir,'test.env');
 try{const handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(lines.join('\n')+'\n');await handle.sync();}finally{await handle.close();}}
 catch {await fs.rm(dir,{recursive:true,force:true});throw new ToolError('Could not install temporary credentials privately');}
 return {credential_file:file,variable_names:[...names]};
}
export async function runInstallTestCredentials(input:{session_id:string;run_id:string;env_mapping?:Record<string,string>}) {
 if(isHosted())throw new ToolError('Hosted builders must use the existing owner browser handoff');
 if(!/^vs_[a-f0-9]{12}$/.test(input.session_id)||!/^vr_[a-f0-9]{32}$/.test(input.run_id))throw new ToolError('Use the session_id and run_id returned by validate_integration');
 if(input.env_mapping && (typeof input.env_mapping!=='object'||Array.isArray(input.env_mapping)))throw new ToolError('Invalid environment mapping');
 const result=await postJsonLong<{secrets:{name:string;value:string}[];expires_in_seconds:number}>(`/api/mcp/native_handoff/${input.session_id}/${input.run_id}`,{},20000);
 if(!Number.isFinite(result.expires_in_seconds)||result.expires_in_seconds<=0)throw new ToolError('Credential handoff expired');
 const installed=await saveCredentialFile(result.secrets,input.env_mapping);
 return {...installed,expires_in_seconds:result.expires_in_seconds,secret_values_returned:false,next:'Load this dotenv file into the disposable app without reading or printing its contents. Set twin base URLs, restart the app, preflight and execute the same run. Remove the file after testing.'};
}
