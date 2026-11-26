/** Local Node test profile: preserve provider protocol, add only correlation.
 * Load with node --import before the app. This is an execution guard, not
 * remote attestation or protection against a deliberately hostile program.
 */
import {pathToFileURL} from "node:url";
import {resolve, relative, isAbsolute, sep} from "node:path";
import {readFileSync, lstatSync, realpathSync, openSync, readSync, fstatSync, closeSync, constants} from "node:fs";
import {createHash} from "node:crypto";

function boundedRead(file: string, limit: number) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("Source reference read budget exceeded");
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!n) break;
      bytes += n;
    }
    if (bytes > stat.size) throw new Error("Source changed during reference read");
    return buffer.subarray(0, bytes);
  } finally { closeSync(fd); }
}

const role = process.env.FETCHSANDBOX_RUNTIME_ROLE ?? "diagnostic";
if (!["original", "candidate", "diagnostic"].includes(role)) throw new Error("Unknown local runtime role");
let sourceReference: string | null = null;
let sourceFileCount = 0;
let entrypoint: string | null = null;
if (role === "original") {
  const referenceFile = process.env.FETCHSANDBOX_ORIGINAL_SOURCE_MANIFEST;
  const expected = process.env.FETCHSANDBOX_ORIGINAL_SOURCE_SHA256;
  const source = process.env.FETCHSANDBOX_APP_SOURCE_ROOT;
  if (!referenceFile || !source || !expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Original runtime requires its owner/CI source reference");
  const stat = lstatSync(referenceFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error("Unqualified original source reference");
  const raw = boundedRead(referenceFile, 128 * 1024);
  sourceReference = createHash("sha256").update(raw).digest("hex");
  if (sourceReference !== expected) throw new Error("Original source reference digest changed");
  const manifest = JSON.parse(raw.toString());
  if (manifest.schema !== "fetchsandbox-source-v1" || manifest.status !== "captured" || !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== "object") throw new Error("Unqualified original source reference");
  const files = Object.entries(manifest.files);
  if (!files.length || files.length > 512) throw new Error("Original source reference budget exceeded");
  const root = realpathSync(source);
  let bytes = 0;
  for (const [name, digest] of files) {
    if (isAbsolute(name) || name.split(/[\\/]/).some(p => p === "..") || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid original source reference");
    const file = resolve(root, name);
    const meta = lstatSync(file);
    bytes += meta.size;
    if (!meta.isFile() || meta.isSymbolicLink() || realpathSync(file) !== file || bytes > 16 * 1024 * 1024) throw new Error("Unqualified original source file");
    if (createHash("sha256").update(boundedRead(file, meta.size)).digest("hex") !== digest) throw new Error("Original source no longer matches its frozen reference");
  }
  if (!process.argv[1]) throw new Error("Original runtime requires its ordinary app entry point");
  entrypoint = relative(root, realpathSync(process.argv[1])).split(sep).join("/");
  if (!Object.hasOwn(manifest.files, entrypoint)) throw new Error("Original runtime refuses an unlisted wrapper entry point");
  sourceFileCount = files.length;
}

// Refuse pre-existing loaders instead of blessing an already wrapped client.
// This profile is deliberately narrower than arbitrary Node startup options.
const extraLoader = /(?:^|\s)(?:--require(?:=|\s)|-r|--(?:experimental-)?loader(?:=|\s)|--import(?:=|\s))/;
if (extraLoader.test(process.env.NODE_OPTIONS ?? "")) throw new Error("Run-header profile cannot qualify other startup loaders");
const argv = process.execArgv;
if (argv.some(arg => arg.startsWith("-r") || arg.startsWith("--require") || arg.startsWith("--loader") || arg.startsWith("--experimental-loader")) ||
    argv.filter(arg => arg === "--import" || arg.startsWith("--import=")).length !== 1) {
  throw new Error("Run-header profile must be the only startup preload");
}
const index = argv.findIndex(arg => arg === "--import" || arg.startsWith("--import="));
const selected = argv[index] === "--import" ? argv[index + 1] : argv[index].slice("--import=".length);
if (!selected || (selected.startsWith("file:") ? new URL(selected).href : pathToFileURL(resolve(selected)).href) !== import.meta.url) {
  throw new Error("Run-header profile must be the declared startup preload");
}
const run = process.env.FETCHSANDBOX_FLOW_RUN_ID;
if (!run || !/^[A-Za-z0-9_-]{1,128}$/.test(run)) {
  throw new Error("FetchSandbox run-header profile requires its exact run ID");
}
let values: unknown;
try { values = JSON.parse(process.env.FETCHSANDBOX_TEST_PROVIDER_BASES ?? ""); }
catch { throw new Error("FetchSandbox run-header profile requires explicit test provider bases"); }
if (!Array.isArray(values) || !values.length || values.length > 20) {
  throw new Error("FetchSandbox run-header profile requires explicit test provider bases");
}
const bases = values.map((value: unknown) => {
  if (typeof value !== "string") throw new Error("Invalid test provider base");
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Invalid test provider base"); }
  const factory = url.protocol === "https:" && url.hostname === "fetchsandbox.com" && (!url.port || url.port === "443") && url.pathname !== "/";
  const loopback = url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!factory && !loopback) || url.username || url.password || url.search || url.hash) {
    throw new Error("Run-header profile permits only explicit isolated test provider bases");
  }
  return {origin: url.origin, path: url.pathname.replace(/\/$/, "")};
});
if (typeof globalThis.fetch !== "function") throw new Error("Native fetch is required");
const upstream = globalThis.fetch.bind(globalThis);
const guarded: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (!bases.some(base => url.origin === base.origin && (url.pathname === base.path || url.pathname.startsWith(base.path + "/")))) {
    throw new Error("Request is outside the configured test provider boundary");
  }
  const headers = new Headers(request.headers);
  const existing = headers.get("X-Flow-Run-Id");
  if (existing && existing !== run) throw new Error("Request belongs to a different test run");
  headers.set("X-Flow-Run-Id", run);
  // Request cloning preserves URL/query, method, body and other request options.
  // No parsing/enrichment of provider responses, and no test verdict here.
  // Native redirect behavior is retained; this is not a network security proxy.
  return upstream(new Request(request, {headers}));
};
Object.defineProperty(globalThis, "fetch", {value: guarded, writable: false, configurable: false});
// This record describes local startup checks, never a business verdict.
process.stderr.write("FS_RUNTIME_BINDING=" + JSON.stringify({profile: "node_native_fetch_header_only", role,
  run_id: run, pid: process.pid, original_source_manifest_sha256: sourceReference,
  source_file_count: sourceFileCount, entrypoint, source_check: role === "original" ? "matched_at_startup" : "not_requested",
  guard_sha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
  scope: "local project files at startup and native fetch profile; dependencies and remote execution unattested"}) + "\n");

export {};
