import { Access, type AccessRule, Api, Authorise, Session } from "@sugabots/contracts/http";
import { Context } from "effect";
import { HttpApi } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app.test-support.ts";

/**
 * Every endpoint fails closed, and every endpoint says what it lets somebody do.
 *
 * The other HTTP tests each check one route they know about. This one reads
 * the API definition, so an endpoint added without a session check, or
 * without an `Access` rule, fails here rather than shipping. "Which routes did
 * we forget to authorise?" is the question that breaches a multi-tenant
 * product.
 */

/** Public by intent. Anything else reaching here without credentials is a bug. */
const OPEN_ENDPOINTS = new Set(["GET /health", "POST /hooks/routines/:routineId"]);

const STRANGER = "0199a3a0-0000-7000-8000-0000000000ee";

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
	// A system agent is addressed by its key, not by an id.
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

interface Endpoint {
	name: string;
	method: string;
	path: string;
	behindSession: boolean;
	behindAuthorise: boolean;
	rule: AccessRule | undefined;
}

function declaredEndpoints(): Endpoint[] {
	const endpoints: Endpoint[] = [];
	HttpApi.reflect(Api, {
		onGroup: () => {},
		onEndpoint: ({ endpoint, middleware }) => {
			endpoints.push({
				name: `${endpoint.method} ${endpoint.path}`,
				method: endpoint.method,
				path: endpoint.path,
				behindSession: [...middleware].some(({ key }) => key === Session.key),
				behindAuthorise: [...middleware].some(({ key }) => key === Authorise.key),
				rule: Context.getOrUndefined(endpoint.annotations, Access),
			});
		},
	});
	return endpoints.sort((a, b) => a.name.localeCompare(b.name));
}

const protectedEndpoints = declaredEndpoints()
	.filter((endpoint) => !OPEN_ENDPOINTS.has(endpoint.name))
	.map((endpoint) => [endpoint.name, endpoint] as const);

/** An endpoint whose rule names a permission, checked against an id in its path. */
const idAddressed = protectedEndpoints.filter(([, { rule }]) => rule && !("reach" in rule));

function requestTo({ method, path }: Endpoint) {
	return {
		method,
		headers: { "content-type": "application/json" },
		body: method === "GET" || method === "DELETE" ? undefined : "{}",
		path: fill(path),
	};
}

describe("every endpoint requires a session", () => {
	it("discovers protected endpoints", () => {
		expect(protectedEndpoints.length).toBeGreaterThan(20);
	});

	it.each(protectedEndpoints)("%s is behind Session and Authorise", (_name, endpoint) => {
		expect(endpoint.behindSession).toBe(true);
		expect(endpoint.behindAuthorise).toBe(true);
	});

	it.each(protectedEndpoints)("%s refuses an anonymous caller", async (_name, endpoint) => {
		const app = createTestApp({ resolveSession: async () => null });
		const { path, ...init } = requestTo(endpoint);

		const response = await app.request(path, init);

		expect(response.status).toBe(401);
	});

	it("has no stale open endpoints", () => {
		const declared = new Set(declaredEndpoints().map(({ name }) => name));
		expect([...OPEN_ENDPOINTS].filter((name) => !declared.has(name))).toEqual([]);
	});
});

describe("every endpoint says what it lets somebody do", () => {
	it.each(protectedEndpoints)("%s declares an Access rule", (_name, { rule }) => {
		expect(rule).toBeDefined();
		if (rule && "reach" in rule) {
			expect(rule.reach, "a reach rule names where the endpoint is scoped").not.toBe("");
		}
	});

	it.each(idAddressed)(
		"%s refuses a signed-in stranger before reading the request",
		async (_name, endpoint) => {
			const app = createTestApp({
				resolveSession: async () => ({
					user: { id: STRANGER, email: "stranger@example.com", name: "Stranger", image: null },
				}),
			});
			const { path, ...init } = requestTo(endpoint);

			const response = await app.request(path, init);

			expect(response.status).toBe(404);
		},
	);
});
