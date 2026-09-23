import { describe, expect, it } from "vitest";
import { createTestApp } from "./app.test-support.ts";
import { permissionRequiredBy } from "./authorisation.ts";

/**
 * Every route fails closed, and every route says what it lets somebody do.
 *
 * The other HTTP tests each check one route they know about. This one asks the
 * router what routes exist, so a route added without a session check, or
 * without naming the permission it needs, fails here rather than shipping.
 * "Which routes did we forget to authorise?" is the question that breaches a
 * multi-tenant product.
 *
 * Routes are named by their pattern, not listed by hand: adding a route to the
 * chain in `app.ts` adds it to this test automatically.
 */

/** Public by intent. Anything else reaching here without credentials is a bug. */
const OPEN_ROUTES = new Set(["/health", "/hooks/routines/:routineId"]);

/**
 * Routes addressed at something that is not a workspace, a pod or an agent, so
 * there is no id for a `require*` middleware to resolve. Each is scoped by
 * `reachesPod` — the same rule those middlewares apply — inside the store it
 * calls, and the test for that route is where the scoping is asserted.
 *
 * Listing one here is a claim that has to be true. Anything not listed must
 * name its permission at the route.
 */
const AUTHORISED_BY_REACH: Record<string, string> = {
	"GET /me": "the signed-in person, and nothing about a workspace",
	"GET /onboarding": "the signed-in person's own progress",
	"POST /onboarding/complete": "onboarding/store.ts checks the pod and agent named",
	"POST /onboarding/complete-invite": "matches the invitation against this account",
	"GET /threads/:threadId": "threads/store.ts scopes by visibleThread",
	"POST /turns/:turnId/cancel": "turns/store.ts scopes by visibleThread",
	"GET /chats/:chatId/messages": "chats/store.ts scopes by visibleChat",
	"GET /chats/:chatId/history": "chats/store.ts scopes by visibleChat",
	"POST /chats/:chatId/messages": "chats/store.ts scopes by visibleChat",
	"GET /workspaces/:workspaceId/events": "events/access.ts asks Authorization itself",
	"GET /threads/:threadId/events": "events/access.ts asks the same thread visibility",
	"GET /connections/oauth/callback":
		"connections/operations.ts asks again on the way back from the provider",
};

/** better-auth owns its own wildcard and does its own authorisation. */
const DELEGATED_PREFIX = "/auth";

const PLACEHOLDERS: Record<string, string> = {
	workspaceId: "0199a3a0-0000-7000-8000-000000000001",
	podId: "0199a3a0-0000-7000-8000-000000000002",
	agentId: "0199a3a0-0000-7000-8000-000000000003",
	providerId: "0199a3a0-0000-7000-8000-000000000004",
	threadId: "0199a3a0-0000-7000-8000-000000000005",
	chatId: "0199a3a0-0000-7000-8000-000000000008",
	turnId: "0199a3a0-0000-7000-8000-000000000006",
	modelId: "some-model",
	userId: "0199a3a0-0000-7000-8000-000000000007",
	connectionId: "0199a3a0-0000-7000-8000-000000000008",
	routineId: "0199a3a0-0000-7000-8000-000000000009",
	toolCallId: "0199a3a0-0000-7000-8000-00000000000a",
	ruleId: "0199a3a0-0000-7000-8000-00000000000b",
	// A built-in agent is addressed by its key, not by an id.
	key: "summarise",
	id: "0199a3a0-0000-7000-8000-000000000008",
};

function fill(pattern: string): string {
	return pattern.replace(/:(\w+)/g, (_whole, name: string) => {
		const value = PLACEHOLDERS[name];
		if (!value) {
			throw new Error(`No placeholder for :${name} in ${pattern}. Add one to PLACEHOLDERS.`);
		}
		return value;
	});
}

interface Route {
	method: string;
	path: string;
	/** The permission its chain names, if any. */
	permission?: string;
}

/**
 * Hono registers one entry per handler, so a route's middleware and its
 * handler share a method and a path. Middleware registered with `use` is
 * `ALL`, and is not a route of its own.
 */
function declaredRoutes(): Route[] {
	const app = createTestApp({ resolveSession: async () => null });
	const seen = new Map<string, Route>();
	for (const { method, path, handler } of app.routes) {
		if (method === "ALL" || path.startsWith(DELEGATED_PREFIX) || OPEN_ROUTES.has(path)) {
			continue;
		}
		const key = `${method} ${path}`;
		const found = seen.get(key) ?? { method, path };
		seen.set(key, { ...found, permission: found.permission ?? permissionRequiredBy(handler) });
	}
	return [...seen.values()].sort((a, b) =>
		`${a.path}${a.method}`.localeCompare(`${b.path}${b.method}`),
	);
}

const routes = declaredRoutes();
const named = routes.map((route) => [`${route.method} ${route.path}` as const, route] as const);

describe("every route requires a session", () => {
	it("discovers protected routes", () => {
		expect(routes.length).toBeGreaterThan(20);
	});

	it.each(named)("%s refuses an anonymous caller", async (_name, { method, path }) => {
		const app = createTestApp({ resolveSession: async () => null });

		const response = await app.request(fill(path), {
			method,
			headers: { "content-type": "application/json" },
			body: method === "GET" || method === "DELETE" ? undefined : "{}",
		});

		expect(response.status).toBe(401);
	});
});

describe("every route names the permission it needs", () => {
	it.each(named)("%s", (name, route) => {
		if (route.permission === undefined) {
			expect(
				AUTHORISED_BY_REACH[name],
				`${name} names no permission. Add requireWorkspace/requirePod/requireAgent to its ` +
					"chain, or record in AUTHORISED_BY_REACH where it is scoped instead.",
			).toBeDefined();
			return;
		}
		expect(AUTHORISED_BY_REACH[name], `${name} both names a permission and claims reach`).toBe(
			undefined,
		);
	});

	it("has no stale entries in AUTHORISED_BY_REACH", () => {
		const declared = new Set<string>(named.map(([name]) => name));
		expect(Object.keys(AUTHORISED_BY_REACH).filter((name) => !declared.has(name))).toEqual([]);
	});
});
