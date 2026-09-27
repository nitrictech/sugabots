import type { Agent } from "@sugabots/contracts";
import { ModelProviderRepository } from "@sugabots/core/providers/model-providers/model-provider-repository";
import { unimplemented } from "@sugabots/core/testing";
import { AgentAdministration } from "@sugabots/core/workspaces/agents/agent-administration";
import { AgentRepository } from "@sugabots/core/workspaces/agents/agent-repository";
import { testAuthorization } from "@sugabots/core/workspaces/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
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

/** The app with `agents` as the only agent methods it has. */
const app = (agents: Partial<AgentAdministration.Interface> = {}) =>
	createTestApp({
		resolveUser,
		authorization,
		services: unimplemented(AgentAdministration.Service, agents),
	});

const auth = (token: string, body?: unknown): RequestInit => ({
	method: body === undefined ? "GET" : "POST",
	headers: {
		authorization: `Bearer ${token}`,
		...(body === undefined ? {} : { "content-type": "application/json" }),
	},
	body: body === undefined ? undefined : JSON.stringify(body),
});

describe("agent routes", () => {
	it("lists visible agents", async () => {
		const response = await app({ list: () => Effect.succeed([agent]) }).request(
			`/workspaces/${WORKSPACE}/agents`,
			auth("member"),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([agent]);
	});

	it("creates an agent in the pod it is posted to", async () => {
		let created: unknown;
		const response = await app({
			create: (input) => {
				created = input.agent;
				return Effect.succeed(agent);
			},
		}).request(`/pods/${POD}/agents`, auth("member", { name: "Writer", model: MODEL }));

		expect(response.status).toBe(201);
		expect(created).toEqual({ name: "Writer", model: MODEL, podId: POD });
	});

	it("reports a model the workspace does not offer as a bad request", async () => {
		const response = await app({
			create: (input) =>
				Effect.fail(new ModelProviderRepository.ModelNotEnabled({ model: input.agent.model })),
		}).request(`/pods/${POD}/agents`, auth("member", { name: "Writer", model: "disabled" }));

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			_tag: "BadRequest",
			message: "This workspace does not offer that model",
		});
	});

	it("reports a name another agent in the pod has as a conflict", async () => {
		const response = await app({
			create: (input) =>
				Effect.fail(new AgentRepository.AgentNameTaken({ field: "name", value: input.agent.name })),
		}).request(`/pods/${POD}/agents`, auth("member", { name: "Triage", model: MODEL }));

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			_tag: "Conflict",
			message: "Another agent in this pod already has that name",
		});
	});

	it("has no placement endpoint", async () => {
		const response = await app().request(`/agents/${AGENT}/pods/${POD}`, {
			...auth("admin"),
			method: "PUT",
		});
		expect(response.status).toBe(404);
	});

	it("lets a member of the pod edit an agent in it", async () => {
		const response = await app({ update: () => Effect.succeed(agent) }).request(
			`/agents/${AGENT}`,
			{
				...auth("member", { description: "Sorts the inbox" }),
				method: "PATCH",
			},
		);

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
		const response = await app({ remove: () => Effect.void }).request(`/agents/${AGENT}`, {
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
	});

	it("lets the owner delete an agent in their own Personal pod", async () => {
		const response = await app({ remove: () => Effect.void }).request(`/agents/${PERSONAL_AGENT}`, {
			...auth("member"),
			method: "DELETE",
		});

		expect(response.status).toBe(204);
	});
});
