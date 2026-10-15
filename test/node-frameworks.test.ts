import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	renderCrudMatrix,
	renderRiskReport,
	renderScanReport,
	renderTestPlan,
} from "../src/report/markdown.js";
import { renderQaReport } from "../src/report/summary.js";
import { scanRepo } from "../src/scanner/index.js";

function scan(t: TestContext, files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "qa-frameworks-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [file, contents] of Object.entries(files)) {
		const path = join(root, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, contents);
	}
	return scanRepo(root);
}
const pkg = (...frameworks: string[]) =>
	JSON.stringify({ dependencies: Object.fromEntries(frameworks.map((f) => [f, "*"])) });

test("Next App Router respects URL conventions and exported HTTP handlers", (t) => {
	const result = scan(t, {
		"package.json": pkg("next"),
		"app/page.tsx": "export default function Page() {}",
		"app/(shop)/products/[id]/page.tsx": "export default function Page() {}",
		"app/@sidebar/products/[id]/page.tsx": "export default function Page() {}",
		"app/docs/[[...slug]]/page.tsx": "export default function Page() {}",
		"app/blog/[...slug]/page.tsx": "export default function Page() {}",
		"app/_private/page.tsx": "",
		"app/(.)photo/page.tsx": "",
		"app/products/layout.tsx": "",
		"app/api/products/[id]/route.ts": `// export function DELETE() {}
const text = "export function PUT() {}";
export async function GET() {}
export const POST = () => {};
const handler = () => {};
export { handler as PATCH };
export function HEAD() {}
export function OPTIONS() {}`,
		"app/api/ignored/route.ts": `const GET = () => {}; export type { Something as DELETE }; export { type Something as PUT };`,
		"app/routes/fake.tsx": "",
		"src/app/ignored/page.tsx": "",
	});
	assert.deepEqual(result.bundle.routes.map((r) => r.routePath).sort(), [
		"/",
		"/blog/:slug+",
		"/docs/:slug*",
		"/products/:id",
		"/products/:id",
	]);
	assert.deepEqual(
		result.bundle.endpoints.map((e) => `${e.method} ${e.path}`).sort(),
		["GET", "HEAD", "OPTIONS", "PATCH", "POST"].map((m) => `${m} /api/products/:id`).sort(),
	);
	assert.equal(result.bundle.endpoints.find((e) => e.method === "GET")?.line, 3);
	assert.equal(result.bundle.endpoints.find((e) => e.method === "HEAD")?.isMutation, false);
});

test("Next Pages Router and src roots stay within monorepo package boundaries", (t) => {
	const result = scan(t, {
		"package.json": JSON.stringify({ private: true }),
		"apps/web/package.json": pkg("next"),
		"apps/web/src/pages/index.tsx": "export default function Page() {}",
		"apps/web/src/pages/users/[id].tsx": "export default function Page() {}",
		"apps/web/src/pages/docs/[...parts].tsx": "export default function Page() {}",
		"apps/web/src/pages/_app.tsx": "",
		"apps/web/src/pages/_document.tsx": "",
		"apps/web/src/pages/_error.tsx": "",
		"apps/web/src/pages/users.test.tsx": "",
		"apps/web/src/pages/api/users/index.ts": "export default function handler(req,res) {}",
		"apps/web/src/pages/api/not-handler.ts": `const text = "export default";`,
		"apps/other/package.json": pkg("express"),
		"apps/other/app/page.tsx": "",
	});
	assert.deepEqual(result.bundle.routes.map((r) => r.routePath).sort(), [
		"/",
		"/docs/:parts+",
		"/users/:id",
	]);
	assert.deepEqual(
		result.bundle.endpoints.map((e) => [e.method, e.path]),
		[["ALL", "/api/users"]],
	);
	assert.ok(result.bundle.routes.every((r) => r.file.startsWith("apps/web/")));
});

test("Express traces ESM routers, mounts, nested prefixes and chained methods", (t) => {
	const result = scan(t, {
		"package.json": pkg("express"),
		"src/server.ts": `import express from 'express';
import users from './users.js';
import { audit } from './audit.js';
const app = express();
app.get('/health', handler);
app.use('/api/users', users);
app.use('/staff/users', users);
app.use('/admin', audit);
app.use(dynamicPrefix, users);
client.get('/not-a-server', handler);
const text = "app.delete('/not-code', handler)";
// app.delete('/comment', handler)
function factory(app) { app.get('/shadow', handler); }
app.get('/dynamic' + suffix, handler);
app.get('/setting');`,
		"src/users.ts": `import { Router as makeRouter } from 'express';
const router = makeRouter();
const nested = makeRouter();
router.route('/:id').get(handler).patch(handler).delete(handler);
router.use('/:id/events', nested);
nested.post('/', handler);
export default router;`,
		"src/audit.ts": `import express from 'express';
export const audit = express.Router();
audit.head('/audit', handler);
audit.options('/audit', handler);
audit.all('/catch', handler);`,
		"src/unmounted.ts": `import { Router } from 'express'; const router = Router(); router.get('/hidden', handler);`,
		"src/server.test.ts": `import express from 'express'; const app=express(); app.get('/fixture',handler);`,
	});
	const actual = result.bundle.endpoints.map((e) => `${e.method} ${e.path}`).sort();
	const expected = ["GET /health", "HEAD /admin/audit", "OPTIONS /admin/audit", "ALL /admin/catch"];
	for (const prefix of ["/api/users", "/staff/users"])
		expected.push(
			...["GET", "PATCH", "DELETE"].map((m) => `${m} ${prefix}/:id`),
			`POST ${prefix}/:id/events`,
		);
	assert.deepEqual(actual, expected.sort());
	assert.ok(result.bundle.endpoints.find((e) => e.method === "ALL")?.isMutation);
	assert.equal(result.bundle.endpoints.find((e) => e.path === "/health")?.line, 5);
});

test("Express CommonJS default routers resolve relative files and mount cycles terminate", (t) => {
	const result = scan(t, {
		"package.json": pkg("express"),
		"server.cjs": `const express=require('express'); const app=express(); const router=require('./router'); app.use('/v1',router);`,
		"router.js": `const {Router: makeRouter}=require('express'); const router=makeRouter(); router.get('/users',handler); router.use('/cycle',router); module.exports=router;`,
	});
	assert.deepEqual(
		result.bundle.endpoints.map((e) => e.path),
		["/v1/users"],
	);
});

test("Fastify supports literal shorthand and method arrays without guessing plugins", (t) => {
	const result = scan(t, {
		"package.json": pkg("fastify"),
		"server.ts": `import Fastify from 'fastify';
const app=Fastify({logger:true});
app.get('/health', {}, handler);
app.route({method:['GET','POST'],url:'/users',handler:()=>{client.get('/fake')}});
app.route({method:'DELETE',url:dynamic,handler});
app.route({method:'POST',url:'/prefix'+suffix,handler});
app.register(async function plugin(app) {app.get('/hidden',handler)}, {prefix:'/v2'});
app.options('/users',handler);`,
	});
	assert.deepEqual(result.bundle.endpoints.map((e) => `${e.method} ${e.path}`).sort(), [
		"GET /health",
		"GET /users",
		"OPTIONS /users",
		"POST /users",
	]);
});

test("popular frontend frameworks are recognized without claiming route discovery", (t) => {
	const result = scan(t, {
		"package.json": pkg("vue", "nuxt", "@sveltejs/kit", "@angular/core", "astro"),
		"app/routes/fake.tsx": "",
	});
	assert.deepEqual(result.project.frameworks.sort(), [
		"angular",
		"astro",
		"nuxt",
		"sveltekit",
		"vue",
	]);
	assert.deepEqual(result.bundle.routes, []);
});

test("Fastify inline CommonJS creation is recognized", (t) => {
	const result = scan(t, {
		"package.json": pkg("fastify"),
		"server.cjs": "const app=require('fastify')({logger:true}); app.post('/users',handler);",
	});
	assert.deepEqual(
		result.bundle.endpoints.map((e) => [e.method, e.path]),
		[["POST", "/users"]],
	);
});

test("generated scan, plan and summary labels are ASCII while external names stay verbatim", (t) => {
	const result = scan(t, {
		"package.json": pkg("express"),
		"server.js":
			"import express from 'express'; const app=express(); app.post('/admin/users',handler);",
	});
	const reports = [
		renderScanReport(result),
		renderCrudMatrix(result.flows, result.registry),
		renderRiskReport(result.registry),
		renderTestPlan(result.registry),
		renderQaReport({
			registry: result.registry,
			artifacts: {
				scanReport: true,
				crudMatrix: true,
				riskReport: true,
				testPlan: true,
				verificationReport: false,
			},
		}),
	];
	for (const report of reports) assert.ok([...report].every((c) => c.charCodeAt(0) < 128));
	result.project.name = "caf\u00e9";
	assert.ok(renderScanReport(result).includes("caf\u00e9"));
});
