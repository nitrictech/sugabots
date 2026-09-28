import type { Agent } from "@sugabots/contracts";
import { ModelProviderRepository } from "@sugabots/core/providers/model-providers/model-provider-repository";
import { unimplemented } from "@sugabots/core/testing";
import { ActionForbidden, ResourceHidden } from "@sugabots/core/workspaces/access";
import { AgentAdministration } from "@sugabots/core/workspaces/agents/agent-administration";
import { AgentRepository } from "@sugabots/core/workspaces/agents/agent-repository";
import { CurrentActor } from "@sugabots/core/workspaces/current-actor";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp } from "../../http/app.test-support.ts";

/**
 * The agent routes, over doubles of `AgentAdministration`. Who may do what to
 * an agent is decided, and tested, in `agents/agent-administration.test.ts`.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000101";
const POD = "0199a3a0-0000-7000-8000-000000000301";
const AGENT = "0199a3a0-0000-7000-8000-000000000201";
const MEMBER = "0199a3a0-0000-7000-8000-000000000002";
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

const resolveUser: UserResolver = async () => ({
	id: MEMBER,
	name: "Sam",
	email: "sam@example.com",
	image: null,
});

/** The app with `agents` as the only agent methods it has. */
const app = (agents: Partial<AgentAdministration.Interface> = {}) =>
	createTestApp({ resolveUser, services: unimplemented(AgentAdministration.Service, agents) });

const auth = (body?: unknown): RequestInit => ({
	method: body === undefined ? "GET" : "POST",
	headers: {
		authorization: "Bearer member",
		...(body === undefined ? {} : { "content-type": "application/json" }),
	},
	body: body === undefined ? undefined : JSON.stringify(body),
});

describe("agent routes", () => {
	it("lists the agents in the workspace in the path", async () => {
		let asked: unknown;
		const response = await app({
			list: (input) => {
				asked = input;
				return Effect.succeed([agent]);
			},
		}).request(`/workspaces/${WORKSPACE}/agents`, auth());

		expect(response.status).toBe(200);
		expect(asked).toEqual({ workspace: WORKSPACE });
		expect(await response.json()).toEqual([agent]);
	});

	it("creates an agent in the pod it is posted to, as the person asking", async () => {
		let created: unknown;
		const response = await app({
			create: (input) =>
				Effect.map(CurrentActor.Service, ({ userId }) => {
					created = { ...input, userId };
					return agent;
				}),
		}).request(`/pods/${POD}/agents`, auth({ name: "Writer", model: MODEL }));

		expect(response.status).toBe(201);
		expect(created).toEqual({
			podId: POD,
			agent: { name: "Writer", model: MODEL },
			userId: MEMBER,
		});
	});

	it("reports a model the workspace does not offer as a bad request", async () => {
		const response = await app({
			create: (input) =>
				Effect.fail(new ModelProviderRepository.ModelNotEnabled({ model: input.agent.model })),
		}).request(`/pods/${POD}/agents`, auth({ name: "Writer", model: "disabled" }));

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
		}).request(`/pods/${POD}/agents`, auth({ name: "Triage", model: MODEL }));

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			_tag: "Conflict",
			message: "Another agent in this pod already has that name",
		});
	});

	it("has no placement endpoint", async () => {
		const response = await app().request(`/agents/${AGENT}/pods/${POD}`, {
			...auth(),
			method: "PUT",
		});
		expect(response.status).toBe(404);
	});

	it("reads, edits and deletes the agent in the path", async () => {
		const asked: unknown[] = [];
		const record = (input: unknown) =>
			Effect.sync(() => {
				asked.push(input);
			});
		const routes = app({
			get: (input) => Effect.as(record(input), agent),
			update: (input) => Effect.as(record(input), agent),
			remove: record,
		});

		expect((await routes.request(`/agents/${AGENT}`, auth())).status).toBe(200);
		expect(
			(
				await routes.request(`/agents/${AGENT}`, {
					...auth({ description: "Sorts the inbox" }),
					method: "PATCH",
				})
			).status,
		).toBe(200);
		expect((await routes.request(`/agents/${AGENT}`, { ...auth(), method: "DELETE" })).status).toBe(
			204,
		);
		expect(asked).toEqual([
			{ agentId: AGENT },
			{ agentId: AGENT, changes: { description: "Sorts the inbox" } },
			{ agentId: AGENT },
		]);
	});

	it("answers an agent hidden from the caller as not found", async () => {
		const response = await app({
			get: () => Effect.fail(new ResourceHidden({ resource: "agent" })),
		}).request(`/agents/${AGENT}`, auth());

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ _tag: "NotFound", message: "No such agent" });
	});

	it("answers a change the caller may not make as forbidden", async () => {
		const response = await app({
			remove: () => Effect.fail(new ActionForbidden({ permission: "agent.delete" })),
		}).request(`/agents/${AGENT}`, { ...auth(), method: "DELETE" });

		expect(response.status).toBe(403);
	});
});
