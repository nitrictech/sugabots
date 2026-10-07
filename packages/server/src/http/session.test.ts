import { Api, Session } from "@sugabots/contracts/http";
import { HttpApi } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";
import { createTestApp, identifiedBy } from "./app.test-support.ts";

/**
 * Every endpoint fails closed without a session.
 *
 * The other HTTP tests each check one route they know about. This one reads
 * the API definition, so an endpoint added without a session check fails here
 * rather than shipping. What a signed-in person may do is decided by the use
 * case each endpoint calls, which refuses in core whoever called it.
 */

/** Public by intent. Anything else reaching here without credentials is a bug. */
const OPEN_ENDPOINTS = new Set([
	"GET /health",
	"POST /hooks/routines/:routineId",
	"POST /hooks/git-hosts/:gitHostId",
]);

const PLACEHOLDERS: Record<string, string> = {
	workspace: "0199a3a0-0000-7000-8000-000000000001",
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
	memberId: "0199a3a0-0000-7000-8000-00000000000c",
	invitationId: "0199a3a0-0000-7000-8000-00000000000d",
	host: "api.example.com",
	gitHostId: "0199a3a0-0000-7000-8000-00000000000e",
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
			});
		},
	});
	return endpoints.sort((a, b) => a.name.localeCompare(b.name));
}

const protectedEndpoints = declaredEndpoints()
	.filter((endpoint) => !OPEN_ENDPOINTS.has(endpoint.name))
	.map((endpoint) => [endpoint.name, endpoint] as const);

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

	it.each(protectedEndpoints)("%s is behind Session", (_name, endpoint) => {
		expect(endpoint.behindSession).toBe(true);
	});

	it.each(protectedEndpoints)("%s refuses an anonymous caller", async (_name, endpoint) => {
		const app = createTestApp(identifiedBy(async () => null));
		const { path, ...init } = requestTo(endpoint);

		const response = await app.request(path, init);

		expect(response.status).toBe(401);
	});

	it("has no stale open endpoints", () => {
		const declared = new Set(declaredEndpoints().map(({ name }) => name));
		expect([...OPEN_ENDPOINTS].filter((name) => !declared.has(name))).toEqual([]);
	});
});
