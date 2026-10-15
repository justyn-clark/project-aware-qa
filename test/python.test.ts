/**
 * Python deep adapter parsers: FastAPI/Flask decorator routes (APIRouter/Blueprint
 * prefixes, Pydantic body types, `{id}` -> `:id`) and Django urls.py + DRF router expansion.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDjangoUrls, parsePyDecoratorRoutes } from "../src/stacks/python.js";

const FASTAPI = `
router = APIRouter(prefix="/api/users", tags=["users"])

@router.get("/{user_id}")
async def get_user(user_id: str) -> User:
    return ...

@router.post("")
async def create_user(payload: CreateUser, request: Request) -> User:
    return ...

@app.get("/health")
def health():
    return {"ok": True}
`;

test("fastapi: APIRouter prefix + verbs + {param} normalization + Pydantic body", () => {
	const eps = parsePyDecoratorRoutes("users.py", FASTAPI, new Set(["CreateUser", "User"]));
	const by = (m: string, p: string) => eps.find((e) => e.method === m && e.path === p);

	const get = by("GET", "/api/users/:user_id");
	assert.ok(get, "GET /api/users/:user_id");
	assert.equal(get?.handler, "get_user");
	assert.equal(get?.isMutation, false);

	const post = by("POST", "/api/users");
	assert.ok(post, "POST /api/users (empty subpath joins to prefix)");
	assert.equal(post?.bodyDto, "CreateUser", "Pydantic body type detected");
	assert.equal(post?.isMutation, true);

	// app-level route has no prefix.
	assert.ok(by("GET", "/health"), "GET /health");
});

const FLASK = `
bp = Blueprint("admin", __name__, url_prefix="/admin")

@bp.route("/items", methods=["GET", "POST"])
def items():
    return ...
`;

test("flask: Blueprint url_prefix + methods= list -> multiple endpoints, admin-flagged", () => {
	const eps = parsePyDecoratorRoutes("admin.py", FLASK, new Set());
	const paths = eps.map((e) => `${e.method} ${e.path}`);
	assert.ok(paths.includes("GET /admin/items"));
	assert.ok(paths.includes("POST /admin/items"));
	assert.ok(
		eps.every((e) => e.isAdmin),
		"under /admin -> privileged",
	);
});

const DJANGO = `
urlpatterns = [
    path("", views.home, name="home"),
    path("products/<int:pk>/", views.product_detail, name="product"),
    path("api/", include("api.urls")),
]
router.register("orders", OrderViewSet)
`;

test("django: path() routes + <int:pk> params, include() skipped, DRF router expansion", () => {
	const { routes, endpoints } = parseDjangoUrls("urls.py", DJANGO);

	assert.ok(routes.some((r) => r.routePath === "/" && r.kind === "django-url"));
	assert.ok(
		routes.some((r) => r.routePath.startsWith("/products/:pk")),
		"<int:pk> -> :pk",
	);
	assert.ok(!routes.some((r) => r.routePath.includes("api")), "include() is skipped");

	const orderPaths = endpoints
		.filter((e) => e.controller === "OrderViewSet")
		.map((e) => `${e.method} ${e.path}`);
	assert.ok(orderPaths.includes("GET /orders"), "DRF list");
	assert.ok(orderPaths.includes("POST /orders"), "DRF create");
	assert.ok(orderPaths.includes("DELETE /orders/:id"), "DRF destroy");
});
