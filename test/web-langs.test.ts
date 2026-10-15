/**
 * Deep adapters for Rust (axum/actix/Rocket), Java (Spring/JAX-RS), and C# (ASP.NET Core).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCSharpRoutes } from "../src/stacks/csharp.js";
import { parseJavaController } from "../src/stacks/java.js";
import { parseRustRoutes } from "../src/stacks/rust.js";

const sig = (eps: { method: string; path: string }[]) => eps.map((e) => `${e.method} ${e.path}`);

test("rust axum: chained .route(...).route(get().post()) + :param, plus actix/Rocket macros", () => {
	const src = `
let app = Router::new()
    .route("/", get(root))
    .route("/tracks", get(list).post(create))
    .route("/tracks/:id", get(show).delete(remove));

#[post("/upload")]
async fn upload() {}`;
	const p = sig(parseRustRoutes("main.rs", src));
	assert.ok(p.includes("GET /"));
	assert.ok(p.includes("GET /tracks"));
	assert.ok(p.includes("POST /tracks"), "second method in the chain");
	assert.ok(p.includes("GET /tracks/:id"));
	assert.ok(p.includes("DELETE /tracks/:id"));
	assert.ok(p.includes("POST /upload"), "actix/Rocket attribute macro");
});

test("java spring: class @RequestMapping prefix + method mappings + @RequestBody", () => {
	const src = `
@RestController
@RequestMapping("/api/users")
public class UserController {
    @GetMapping
    public List<User> list() { return null; }

    @GetMapping("/{id}")
    public User get(@PathVariable Long id) { return null; }

    @PostMapping
    public User create(@RequestBody CreateUserRequest body) { return null; }

    @DeleteMapping("/{id}")
    public void remove(@PathVariable Long id) {}
}`;
	const eps = parseJavaController("UserController.java", src);
	const p = sig(eps);
	assert.ok(p.includes("GET /api/users"), "method with no path inherits class prefix");
	assert.ok(p.includes("GET /api/users/:id"));
	assert.ok(p.includes("POST /api/users"));
	assert.ok(p.includes("DELETE /api/users/:id"));
	assert.equal(eps.find((e) => e.method === "POST")?.bodyDto, "CreateUserRequest");
	assert.ok(eps.every((e) => e.entity === "user"));
});

test("csharp: minimal APIs (MapGroup) + MVC controller ([controller] + [FromBody])", () => {
	const src = `
app.MapGet("/health", Health);
var api = app.MapGroup("/api");
api.MapGet("/users", ListUsers);
api.MapPost("/users", CreateUser);

[ApiController]
[Route("api/[controller]")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok();

    [HttpGet("{id}")]
    public IActionResult Get(int id) => Ok();

    [HttpPost]
    public IActionResult Create([FromBody] CreateProductRequest req) => Ok();
}`;
	const eps = parseCSharpRoutes("Api.cs", src);
	const p = sig(eps);
	assert.ok(p.includes("GET /health"));
	assert.ok(p.includes("GET /api/users"), "MapGroup prefix");
	assert.ok(p.includes("POST /api/users"));
	assert.ok(p.includes("GET /api/products"), "[controller] token -> products");
	assert.ok(p.includes("GET /api/products/:id"));
	assert.equal(
		eps.find((e) => e.path === "/api/products" && e.method === "POST")?.bodyDto,
		"CreateProductRequest",
	);
});
