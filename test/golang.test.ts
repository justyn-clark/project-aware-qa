/**
 * Go deep adapter route parsing: chi `Route` closure prefixes (incl. shadowed router var),
 * echo/gin Group-variable prefixes, gorilla `.Methods(...)`, and Go 1.22 stdlib patterns.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGoRoutes } from "../src/stacks/golang.js";

const paths = (src: string) => parseGoRoutes("routes.go", src).map((e) => `${e.method} ${e.path}`);

test("chi: nested Route closures compound prefixes (with shadowed `r`)", () => {
	const src = `
func routes() {
	r := chi.NewRouter()
	r.Get("/health", healthHandler.Health)
	r.Route("/api", func(r chi.Router) {
		r.Post("/auth/login", authHandler.Login)
		r.Route("/users", func(r chi.Router) {
			r.Get("/", userHandler.ListUsers)
			r.Get("/{id}", userHandler.GetUser)
			r.Delete("/{id}", userHandler.DeleteUser)
		})
	})
}`;
	const p = paths(src);
	assert.ok(p.includes("GET /health"), "top-level route, no prefix");
	assert.ok(p.includes("POST /api/auth/login"));
	assert.ok(p.includes("GET /api/users"));
	assert.ok(p.includes("GET /api/users/:id"), "{id} -> :id, nested prefix");
	assert.ok(p.includes("DELETE /api/users/:id"));
});

test("echo/gin: Group variable prefixes", () => {
	const src = `
e := echo.New()
api := e.Group("/v1")
api.GET("/vendors", listVendors)
api.POST("/vendors/:id/state", setState)`;
	const p = paths(src);
	assert.ok(p.includes("GET /v1/vendors"));
	assert.ok(p.includes("POST /v1/vendors/:id/state"));
});

test("gorilla: HandleFunc + .Methods(...) -> one endpoint per method", () => {
	const src = `
r := mux.NewRouter()
r.HandleFunc("/products", productsHandler).Methods("GET", "POST")`;
	const p = paths(src);
	assert.ok(p.includes("GET /products"));
	assert.ok(p.includes("POST /products"));
});

test("stdlib net/http: Go 1.22 method patterns + method-less default GET", () => {
	const src = `
mux := http.NewServeMux()
mux.HandleFunc("GET /items/{id}", getItem)
mux.HandleFunc("/legacy", legacyHandler)`;
	const p = paths(src);
	assert.ok(p.includes("GET /items/:id"), "Go 1.22 'GET /path/{id}'");
	assert.ok(p.includes("GET /legacy"), "method-less -> GET");
});

test("fiber: app-level routes have no prefix", () => {
	const src = `
app := fiber.New()
app.Get("/", handlers.Home)
app.Post("/upload", handlers.Upload)`;
	const p = paths(src);
	assert.ok(p.includes("GET /"));
	assert.ok(p.includes("POST /upload"));
});
