/**
 * What actually ends up in the tarball, and which directories we agree to read.
 *
 * These assert the STATE the pack produces — the real archive on disk, listed
 * with the real tar — not that some function was called. A test that trusts the
 * exclude list to work is testing the list against itself.
 *
 * Reported 2026-09-12 by a user reading the published source: the exclude list
 * named build dirs and agent files and no credentials at all, so `.env` shipped.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const { packDirToBase64, resolveWorkspaceDir } = await import("../dist/tools/pack.js");

/**
 * Fixture credentials are ASSEMBLED, never written as literals.
 *
 * GitHub's push protection blocked the public mirror over a Stripe-shaped
 * string in this file — correctly: it cannot tell a test fixture from a leak,
 * and neither can any other scanner. A literal here would also sit in the
 * published tarball forever. The scan under test sees the joined value, so the
 * test is exactly as strong.
 */
const FAKE = {
  stripe: () => "sk_" + "live_" + "51AbCdEfGhIjKlMnOpQrStUv",
  aws: () => "AKIA" + "IOSFODNN7EXAMPLE",
  awsOutside: () => "AKIA" + "OUTSIDETHETREE00",
  rsa: () => "-----BEGIN RSA " + "PRIVATE KEY-----",
  openssh: () => "-----BEGIN OPENSSH " + "PRIVATE KEY-----",
};

function repo() {
  const root = mkdtempSync(join(tmpdir(), "fs-packtest-"));
  const proj = join(root, "proj");
  mkdirSync(join(proj, "src"), { recursive: true });
  mkdirSync(join(proj, "config"), { recursive: true });
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  writeFileSync(join(proj, "package.json"), '{"name":"p"}');
  writeFileSync(join(proj, "src", "a.js"), "console.log(1)\n");
  writeFileSync(join(root, "elsewhere", "creds.txt"), FAKE.awsOutside() + "\n");
  return { root, proj };
}

/** Run fn with the process cwd set to dir — the boundary is measured from cwd. */
function inside(dir, fn) {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(cwd);
  }
}

function entries(dir) {
  const { b64 } = packDirToBase64(dir);
  const tar = join(mkdtempSync(join(tmpdir(), "fs-packread-")), "ws.tar.gz");
  writeFileSync(tar, Buffer.from(b64, "base64"));
  return execFileSync("tar", ["-tzf", tar]).toString().split("\n").filter(Boolean);
}

test("credential-shaped files never reach the archive", () => {
  const { root, proj } = repo();
  writeFileSync(join(proj, ".env"), `STRIPE_KEY=${FAKE.stripe()}\n`);
  writeFileSync(join(proj, ".env.local"), `AWS=${FAKE.aws()}\n`);
  writeFileSync(join(proj, "server.pem"), FAKE.rsa() + "\nx\n");
  writeFileSync(join(proj, "id_rsa"), FAKE.openssh() + "\nx\n");

  const listed = inside(proj, () => entries(proj));
  for (const leaked of [".env", ".env.local", "server.pem", "id_rsa"]) {
    assert.ok(!listed.some((e) => e.endsWith(leaked)), `${leaked} is in the tarball`);
  }
  assert.ok(listed.some((e) => e.endsWith("src/a.js")), "source should still be packed");
  rmSync(root, { recursive: true, force: true });
});

test("a live key under a name no pattern covers stops the upload", () => {
  const { root, proj } = repo();
  writeFileSync(join(proj, "config", "local.yml"), `stripe: ${FAKE.stripe()}\n`);
  inside(proj, () => assert.throws(() => packDirToBase64(proj), /config\/local\.yml/));
  rmSync(root, { recursive: true, force: true });
});

test("the packaged directory is bounded by the client's working directory", () => {
  const { root, proj } = repo();
  const cwd = process.cwd();
  process.chdir(proj);
  try {
    assert.equal(resolveWorkspaceDir(undefined), resolveWorkspaceDir(proj));
    assert.equal(resolveWorkspaceDir("src"), join(resolveWorkspaceDir(proj), "src"));

    // The vector as reported: a line in a repo tells the agent to pass a path.
    for (const outside of ["../elsewhere", resolve(root, "elsewhere"), "/"]) {
      assert.throws(() => resolveWorkspaceDir(outside), /Refusing to package/, outside);
    }

    // A symlink inside the tree cannot be used to step out of it.
    symlinkSync(join(root, "elsewhere"), join(proj, "escape"));
    assert.throws(() => resolveWorkspaceDir("escape"), /Refusing to package/);

    // And tar stores it as a link, so the target's bytes never travel either.
    const { b64 } = packDirToBase64(undefined);
    assert.ok(!Buffer.from(b64, "base64").toString("latin1").includes(FAKE.awsOutside()));
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("FETCHSANDBOX_WORKSPACE_ROOT widens the boundary, a tool argument cannot", () => {
  const { root, proj } = repo();
  const cwd = process.cwd();
  process.chdir(proj);
  process.env.FETCHSANDBOX_WORKSPACE_ROOT = root;
  try {
    assert.equal(resolveWorkspaceDir("../elsewhere"), join(resolveWorkspaceDir(root), "elsewhere"));
  } finally {
    delete process.env.FETCHSANDBOX_WORKSPACE_ROOT;
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("file size cannot switch the scan off", () => {
  // The first scan read each entry through a 4MB subprocess buffer and treated
  // the overflow as "binary, nothing to read". A key past 4MB shipped.
  const { root, proj } = repo();
  const key = FAKE.stripe();
  for (const mb of [5, 20]) {
    writeFileSync(join(proj, "src", `big${mb}.js`), "x".repeat(mb * 1024 * 1024) + `\nk="${key}"\n`);
    assert.throws(() => inside(proj, () => packDirToBase64(proj)), new RegExp(`big${mb}\\.js`));
    rmSync(join(proj, "src", `big${mb}.js`));
  }
  rmSync(root, { recursive: true, force: true });
});

test("a key in a binary file is still a key", () => {
  const { root, proj } = repo();
  writeFileSync(join(proj, "src", "blob.bin"),
    Buffer.concat([Buffer.from([0, 1, 2, 255, 254]), Buffer.from(FAKE.aws())]));
  assert.throws(() => inside(proj, () => packDirToBase64(proj)), /blob\.bin/);
  rmSync(root, { recursive: true, force: true });
});

test("a clean repo still goes through", () => {
  const { root, proj } = repo();
  const listed = inside(proj, () => entries(proj));
  assert.ok(listed.some((e) => e.endsWith("src/a.js")));
  rmSync(root, { recursive: true, force: true });
});
