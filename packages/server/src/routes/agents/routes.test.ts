import type { Agent } from "@sugabots/contracts";
import type { ModelProviderStore } from "@sugabots/core/providers/model-providers/store";
import {
	type AgentStore,
	crewAgentRow,
	PodOutsideWorkspace,
	toAgent,
} from "@sugabots/core/workspaces/agents/store";
import { testAuthorization } from "@sugabots/core/workspaces/testing";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp } from "../../http/app.test-support.ts";

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000101";
const POD = "0199a3a0-0000-7000-8000-000000000301";
const AGENT = "0199a3a0-0000-7000-8000-000000000201";
const PERSONAL_POD = "0199a3a0-0000-7000-8000-000000000302";
const PERSONAL_AGENT = "0199a3a0-0000-7000-8000-000000000202";
const ADMIN = "0199a3a0-0000-7000-8000-000000000001";
const MEMBER = "0199a3a0-0000-7000-8000-000000000002";
const VIEWER = "0199a3a0-0000-7000-8000-000000000003";
const MODEL = "gpt-4o-mini";

const agent: Agent = {
	id: AGENT,
	workspaceId: WORKSPACE,
	podId: POD,
	name: "Triage",
	handle: "triage",
	systemAgentKey: null,
	description: null,
	color: "teal",
	face: "pill",
	model: MODEL,
	prompt: "",
	disabledTools: [],
	createdAt: "2026-09-10T00:00:00.000Z",
};

const people: Record<string, string> = { admin: ADMIN, member: MEMBER, viewer: VIEWER };

const resolveUser: UserResolver = async (headers) => {
	const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "member";
	const id = people[token] ?? MEMBER;
	return { id, name: token, email: `${id}@example.com`, image: null };
};

/**
 * A shared pod Sam has joined and Ada administers from outside, plus Sam's own
 * Personal pod, which Ada cannot reach at all.
 */
const authorization = testAuthorization({
	id: WORKSPACE,
	roles: { [ADMIN]: "admin", [MEMBER]: "member", [VIEWER]: "viewer" },
	pods: [
		{ id: POD, kind: "shared", members: [MEMBER, VIEWER] },
		{ id: PERSONAL_POD, kind: "personal", ownerId: MEMBER, members: [MEMBER] },
	],
	agents: [
		{ id: AGENT, podId: POD, name: agent.name, handle: agent.handle, model: agent.model },
		{ id: PERSONAL_AGENT, podId: PERSONAL_POD },
	],
});

let createdName: string | undefined;
const store: AgentStore = {
	listVisible: () => Effect.succeed([agent]),
	get: () => Effect.succeed(agent),
	fromRow: (row) => {
		const crew = crewAgentRow(row);
		return Effect.succeed(crew ? toAgent(crew) : undefined);
	},
	create: (_workspaceId, _userId, input) =>
		Effect.suspend(() => {
			createdName = input.name;
			return input.podId === POD
				? Effect.succeed({ ...agent, ...input, description: input.description ?? null })
				: Effect.fail(new PodOutsideWorkspace());
		}),
	update: (_workspaceId, _agentId, input) =>
		Effect.succeed({ ...agent, ...input, description: input.description ?? null }),
	remove: () => Effect.void,
};

const modelProviders = {
	isEnabled: (_workspaceId: string, model: string) => Effect.succeed(model === MODEL),
} as unknown as ModelProviderStore;

const app = () =>
	createTestApp({ resolveUser, authorization, stores: { agents: store, modelProviders } });
const auth = (token: string, body?: unknown): RequestInit => ({
	method: body === undefined ? "GET" : "POST",
	headers: {
		authorization: `Bearer ${token}`,
		...(body === undefined ? {} : { "content-type": "application/json" }),
	},
	body: body === undefined ? undefined : JSON.stringify(body),
});

beforeEach(() => {
	createdName = undefined;
});

describe("agent routes", () => {
	it("lists visible agents", async () => {
		const response = await app().request(`/workspaces/${WORKSPACE}/agents`, auth("member"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([agent]);
	});

	it("creates an agent only through its pod", async () => {
		const response = await app().request(
			`/pods/${POD}/agents`,
			auth("member", { name: "Writer", model: MODEL }),
		);
		expect(response.status).toBe(201);
		expect(createdName).toBe("Writer");
	});

	it("rejects a disabled model before creating", async () => {
		const response = await app().request(
			`/pods/${POD}/agents`,
			auth("member", { name: "Writer", model: "disabled" }),
		);
		expect(response.status).toBe(400);
		expect(createdName).toBeUndefined();
	});

	it("has no placement endpoint", async () => {
		const response = await app().request(`/agents/${AGENT}/pods/${POD}`, {
			...auth("admin"),
			method: "PUT",
		});
		expect(response.status).toBe(404);
	});

	it("lets a member of the pod edit an agent in it", async () => {
		const response = await app().request(`/agents/${AGENT}`, {
			...auth("member", { description: "Sorts the inbox" }),
			method: "PATCH",
		});

		expect(response.status).toBe(200);
	});

	it("refuses a member deleting a shared-pod agent", async () => {
		const response = await app().request(`/agents/${AGENT}`, {
			...auth("member"),
			method: "DELETE",
		});

		expect(response.status).toBe(403);
	});

	it("lets an admin delete a shared-pod agent they are not a member of", async () => {
		const response = await app().request(`/agents/${AGENT}`, {
			...auth("admin"),
			method: "DELETE",
		});

		expect(response.status).toBe(204);
	});

	it("hides an agent in somebody else's Personal pod from an admin", async () => {
		const response = await app().request(`/agents/${PERSONAL_AGENT}`, auth("admin"));

		expect(response.status).toBe(404);
	});

	it("shows a viewer an agent in a pod they are in", async () => {
		const response = await app().request(`/agents/${AGENT}`, auth("viewer"));

		expect(response.status).toBe(200);
	});

	it("refuses a viewer editing an agent they can see", async () => {
		const response = await app().request(`/agents/${AGENT}`, {
			...auth("viewer", { description: "Not mine to change" }),
			method: "PATCH",
		});

		expect(response.status).toBe(403);
	});

	it("refuses a viewer creating an agent", async () => {
		const response = await app().request(
			`/pods/${POD}/agents`,
			auth("viewer", { name: "Writer", model: MODEL }),
		);

		expect(response.status).toBe(403);
		expect(createdName).toBeUndefined();
	});

	it("lets the owner delete an agent in their own Personal pod", async () => {
		const response = await app().request(`/agents/${PERSONAL_AGENT}`, {
			...auth("member"),
			method: "DELETE",
		});

		expect(response.status).toBe(204);
	});
});
