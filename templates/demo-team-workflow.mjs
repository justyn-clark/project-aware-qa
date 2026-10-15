// Offline integration walkthrough: built CLI, isolated Git fixture, real authenticated HTTP.
// Optional QA_DEMO_PLAYWRIGHT: absolute path to an installed Playwright module for Chromium + trace.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pack = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(pack, ".qa", "demos", `team-${randomUUID()}`);
const cli = join(pack, "dist/src/cli.js");
const token = randomUUID(); // Synthetic credential for this loopback-only fixture.
function put(path, content) {
  const file = join(fixture, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}
function git(...args) {
  const run = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: fixture, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}
function qa(command, flags = [], expected = 0) {
  const run = spawnSync(process.execPath, [cli, command, fixture, ...flags, "--json"], { encoding: "utf8", env: { ...process.env, QA_DEMO_TOKEN: token }, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(run.status, expected, run.stderr || run.stdout);
  return JSON.parse(run.stdout);
}
put("package.json", { name: "qa-demo", private: true, workspaces: ["apps/*", "services/*", "packages/*"] });
put("apps/web/package.json", { name: "web", dependencies: { "@remix-run/react": "*" } });
put("apps/web/app/routes/index.tsx", "export default function Page() { return <h1>Orders</h1>; }\n");
put("services/api/package.json", { name: "api", dependencies: { "@nestjs/common": "*", contracts: "workspace:*" } });
put("services/api/orders.controller.ts", "@Controller('orders') export class OrdersController { @Get() list() { return []; } }\n");
put("packages/contracts/package.json", { name: "contracts" });
put("packages/contracts/index.ts", "export interface Order { id: string }\n");
put(".github/CODEOWNERS", "/apps/web/ @demo/frontend\n/services/api/ @demo/backend\n/packages/ @demo/platform\n");
put(".gitignore", ".qa/\nnode_modules/\n");
mkdirSync(join(fixture, "node_modules"));
put("assert-auth.mjs", `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const token = process.env.QA_DEMO_TOKEN;
assert.ok(token);
const server = createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(401).end('Login required'); return; }
  if (request.url === '/account') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><h1>Orders</h1><p>Authenticated demo account</p>'); return; }
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify([{ id: 'order-1' }]));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const url = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(url)).status, 401);
  const authorized = await fetch(url, { headers: { authorization: 'Bearer ' + token } });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), [{ id: 'order-1' }]);
  if (process.env.QA_DEMO_PLAYWRIGHT) {
    const { chromium } = await import(pathToFileURL(process.env.QA_DEMO_PLAYWRIGHT).href);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ extraHTTPHeaders: { authorization: 'Bearer ' + token } });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    assert.equal((await page.goto(url + '/account')).status(), 200);
    assert.equal(await page.locator('h1').textContent(), 'Orders');
    await page.screenshot({ path: '.qa/account.png' });
    await context.tracing.stop({ path: '.qa/auth-trace.zip' });
  }
  writeFileSync('.qa/assertions.json', JSON.stringify({ unauthenticatedStatus: 401, authenticatedStatus: 200, schemaAssertion: true, browser: Boolean(browser) }));
  console.log('Synthetic credential redaction check:', token);
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
`);
const initial = qa("scan");
const endpoint = initial.scan.registry.surfaces.find(surface => surface.backendEndpoint === "GET /orders");
assert.ok(endpoint);
const config = {
  version: 1,
  dependencies: { "apps/web": ["services/api"] },
  policy: { requiredChecks: ["registry", "behavior-auth"], failOnIncomplete: false },
  behaviorChecks: [{ id: "auth", command: [process.execPath, "assert-auth.mjs"], surfaceIds: [endpoint.id], requiredEnv: ["QA_DEMO_TOKEN"], artifacts: [".qa/assertions.json", ...(process.env.QA_DEMO_PLAYWRIGHT ? [".qa/auth-trace.zip", ".qa/account.png"] : [])] }]
};
put(".project-aware-qa.json", config);
qa("scan", ["--save-baseline"]);
put("qa-baseline.json", readFileSync(join(fixture, ".qa/baseline.json"), "utf8"));
config.baseline = "qa-baseline.json";
put(".project-aware-qa.json", config);
git("init", "-q"); git("config", "user.name", "QA demo"); git("config", "user.email", "demo@example.invalid");
git("add", "."); git("commit", "-qm", "Baseline fixture");
put("packages/contracts/index.ts", "export interface Order { id: string; total: number }\n");
qa("scan");
const pass = qa("verify", ["--changed-since", "HEAD", "--tests", "--junit", "--sarif", "--timeout", "20000", "--base-url", "http://127.0.0.1:9"]);
const check = pass.verify.checks.find(check => check.id === "behavior-auth");
assert.equal(check.status, "passed");
assert.deepEqual(pass.verify.selection.affectedRoots, ["apps/web", "packages/contracts", "services/api"]);
assert.ok(!readFileSync(join(fixture, ".qa", check.evidencePath), "utf8").includes(token));
const failed = qa("verify", ["--require", "behavior-auth", "--base-url", "http://127.0.0.1:9"], 1);
assert.equal(failed.verify.policy.passed, false); // --tests was deliberately omitted.
const staleSource = readFileSync(join(fixture, "packages/contracts/index.ts"), "utf8") + "// changed after scan\n";
put("packages/contracts/index.ts", staleSource);
const stale = qa("verify", [], 1);
assert.equal(stale.outcome, "incomplete");
assert.match(readFileSync(join(fixture, ".qa/verification.junit.xml"), "utf8"), /preflight/);
const evidence = { fixture, cli: "compiled standalone CLI", browser: Boolean(process.env.QA_DEMO_PLAYWRIGHT), checks: { dependencyPropagation: "passed", authenticatedHttp: "passed", artifactDigests: "recorded", credentialRedaction: "passed", missingRequiredSuite: "failed as expected", staleSource: "refused as expected", staleExports: "replaced" }, successfulRun: pass.verify.runId, attachments: check.attachments, outcomes: { verified: pass.outcome, skippedRequired: failed.outcome, staleSource: stale.outcome } };
put("walkthrough.json", evidence);
console.log(JSON.stringify(evidence, null, 2));
