import type { Agent } from "@sugabots/contracts";
import { ActionForbidden, ResourceHidden } from "@sugabots/core/authorization/access";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { ModelProviderRepository } from "@sugabots/core/providers/model-providers/model-provider-repository";
import { unimplemented } from "@sugabots/core/testing";
import { AgentAdministration } from "@sugabots/core/workspaces/agents/agent-administration";
import { AgentRepository } from "@sugabots/core/workspaces/agents/agent-repository";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy } from "../../http/app.test-support.ts";

/**
 * The agent routes, over doubles of `AgentAdministration`. Who may do what to
 * an agent is decided, and tested, in `agents/agent-administration.test.ts`.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000101";
const AGENT = "0199a3a0-0000-7000-8000-000000000201";
const MEMBER = "0199a3a0-0000-7000-8000-000000000002";
const MODEL = "gpt-4o-mini";

const agent: Agent = {
	id: AGENT,
	workspaceId: WORKSPACE,
	name: "Triage",
	handle: "triage",
	systemAgentKey: null,
	description: null,
	color: "teal",
	face: "pill",
	shape: "circle",
	model: MODEL,
	prompt: "",
	disabledTools: [],
	usesSandbox: false,
	naturalBrowsing: false,
	createdById: null,
	visibility: "public",
	assistant: false,
	pinned: false,
	permissions: {
		update: true,
		delete: true,
		manageConnections: true,
		manageSandbox: true,
		useDesktop: true,
		manageRoutines: true,
		runRoutines: true,
		decideApprovals: true,
		talk: true,
	},
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
	createTestApp(
		Layer.merge(identifiedBy(resolveUser), unimplemented(AgentAdministration.Service, agents)),
	);

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

	it("creates a bot in the workspace it is posted to, as the person asking", async () => {
		let created: unknown;
		const response = await app({
			create: (input) =>
				Effect.map(CurrentActor.Service, ({ userId }) => {
					created = { ...input, userId };
					return agent;
				}),
		}).request(`/workspaces/${WORKSPACE}/agents`, auth({ name: "Writer", model: MODEL }));

		expect(response.status).toBe(201);
		expect(created).toEqual({
			workspace: WORKSPACE,
			agent: { name: "Writer", model: MODEL },
			userId: MEMBER,
		});
	});

	it("reports a model the workspace does not offer as a bad request", async () => {
		const response = await app({
			create: (input) =>
				Effect.fail(new ModelProviderRepository.ModelNotEnabled({ model: input.agent.model })),
		}).request(`/workspaces/${WORKSPACE}/agents`, auth({ name: "Writer", model: "disabled" }));

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			_tag: "BadRequest",
			message: "This workspace does not offer that model",
		});
	});

	it("reports a name another bot in the workspace has as a conflict", async () => {
		const response = await app({
			create: (input) =>
				Effect.fail(new AgentRepository.AgentNameTaken({ field: "name", value: input.agent.name })),
		}).request(`/workspaces/${WORKSPACE}/agents`, auth({ name: "Triage", model: MODEL }));

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			_tag: "Conflict",
			message: "Another bot in this workspace already has that name",
		});
	});

	it("pins and unpins the bot in the path for the person asking", async () => {
		const asked: unknown[] = [];
		const routes = app({
			setPinned: (input) =>
				Effect.map(CurrentActor.Service, ({ userId }) => {
					asked.push({ ...input, userId });
					return { ...agent, pinned: input.pinned };
				}),
		});

		const pinned = await routes.request(`/agents/${AGENT}/pin`, { ...auth(), method: "PUT" });
		const unpinned = await routes.request(`/agents/${AGENT}/pin`, { ...auth(), method: "DELETE" });

		expect(pinned.status).toBe(200);
		expect(await pinned.json()).toMatchObject({ pinned: true });
		expect(unpinned.status).toBe(200);
		expect(await unpinned.json()).toMatchObject({ pinned: false });
		expect(asked).toEqual([
			{ agentId: AGENT, pinned: true, userId: MEMBER },
			{ agentId: AGENT, pinned: false, userId: MEMBER },
		]);
	});

	it("returns the person's Personal Assistant in the workspace in the path", async () => {
		let asked: unknown;
		const response = await app({
			ensureAssistant: (input) =>
				Effect.sync(() => {
					asked = input;
					return { ...agent, assistant: true, visibility: "private" as const };
				}),
		}).request(`/workspaces/${WORKSPACE}/assistant`, auth({ model: MODEL }));

		expect(response.status).toBe(200);
		expect(asked).toEqual({ workspace: WORKSPACE, model: MODEL });
		expect(await response.json()).toMatchObject({ assistant: true });
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
