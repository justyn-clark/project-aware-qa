/**
 * Multi-stack adapters: generic marker-priority detection, the any-language fallback, and
 * Phoenix router parsing (scopes, pipelines, `resources` expansion, LiveView, auth -> admin).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepoFiles } from "../src/scanner/files.js";
import { genericAdapter } from "../src/stacks/generic.js";
import { parseRouter } from "../src/stacks/phoenix.js";

function repo(paths: string[]): RepoFiles {
	return {
		root: "/x",
		truncated: false,
		totalSeen: true,
		files: paths.map((p) => {
			const i = p.lastIndexOf(".");
			return { path: p, abs: `/x/${p}`, ext: i < 0 ? "" : p.slice(i).toLowerCase(), size: 1 };
		}),
	};
}

test("generic detect: a language manifest outranks a bare Makefile in the same dir", () => {
	const matches = genericAdapter.detect(
		repo(["Makefile", "mix.exs", "lib/app.ex", "test/app_test.exs"]),
	);
	assert.equal(matches.length, 1);
	assert.match(matches[0]?.label ?? "", /Elixir/);
});

test("generic detect: Go module", () => {
	const matches = genericAdapter.detect(repo(["go.mod", "main.go", "main_test.go"]));
	assert.equal(matches[0]?.label, "Go");
});

test("generic detect: a real C/C++ project (Makefile only) is still C/C++", () => {
	const matches = genericAdapter.detect(repo(["Makefile", "src/main.c", "src/util.c"]));
	assert.equal(matches[0]?.label, "C / C++");
});

test("generic detect: unknown build file falls back to dominant source extension", () => {
	const matches = genericAdapter.detect(repo(["main.odin", "util.odin", "README.md"]));
	assert.equal(matches[0]?.label, "Odin");
});

test("generic scan: Elixir without Phoenix -> baseline test-gap + mix checks", () => {
	const r = repo(["mix.exs", "lib/a.ex", "lib/b.ex", "test/a_test.exs"]);
	const match = genericAdapter.detect(r)[0];
	if (!match) throw new Error("expected a generic stack match");
	const scan = genericAdapter.scan(r, match);
	assert.equal(scan.stack.language, "elixir");
	assert.equal(scan.stack.checks.test?.command, "mix test");
	assert.equal(scan.bundle.tests.length, 1);
	assert.equal(scan.extraSurfaces.length, 1);
	assert.equal(scan.extraSurfaces[0]?.type, "test-gap");
});

const ROUTER = `
defmodule MyappWeb.Router do
  use MyappWeb, :router

  scope "/", MyappWeb do
    pipe_through :browser
    get "/", PageController, :index
    live "/dashboard", DashboardLive, :index
  end

  scope "/api", MyappWeb.API do
    pipe_through :api
    resources "/users", UsersController, except: [:new, :edit]
  end

  scope "/admin", MyappWeb.Admin do
    pipe_through [:browser, :require_authenticated_user]
    resources "/tracks", TrackController
  end
end
`;

test("phoenix parseRouter: verbs, live, and resources expansion", () => {
	const { routes, endpoints } = parseRouter("router.ex", ROUTER, new Map());

	// GET "/" -> a page route; live "/dashboard" -> a live route.
	assert.ok(routes.some((r) => r.routePath === "/" && r.kind === "phoenix-router"));
	assert.ok(routes.some((r) => r.routePath === "/dashboard" && r.kind === "phoenix-live"));

	// resources "/users" except new/edit -> index/create/show/update/delete (5), not new/edit.
	const userPaths = endpoints
		.filter((e) => e.controller === "UsersController")
		.map((e) => `${e.method} ${e.path}`);
	assert.ok(userPaths.includes("GET /api/users"));
	assert.ok(userPaths.includes("POST /api/users"));
	assert.ok(userPaths.includes("DELETE /api/users/:id"));
	assert.ok(!userPaths.some((p) => p.endsWith("/new")));
	assert.ok(!userPaths.some((p) => p.endsWith("/edit")));
});

test("phoenix parseRouter: nested scope prefixes + auth pipeline -> admin", () => {
	const { endpoints } = parseRouter("router.ex", ROUTER, new Map());
	const track = endpoints.find((e) => e.controller === "TrackController" && e.method === "POST");
	assert.equal(track?.path, "/admin/tracks");
	assert.equal(track?.isAdmin, true, "require_authenticated_user pipeline marks it privileged");
	assert.equal(track?.isMutation, true);
});

test("phoenix parseRouter: entity inference from controller/path", () => {
	const { endpoints } = parseRouter("router.ex", ROUTER, new Map());
	assert.ok(endpoints.some((e) => e.entity === "user"));
	assert.ok(endpoints.some((e) => e.entity === "track"));
});
