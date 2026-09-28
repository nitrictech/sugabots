import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	agent,
	modelProvider,
	pod,
	providerModel,
	user,
	workspace,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	servedOnPostgres,
} from "../../database/testing.ts";
import { ModelProviderRepository } from "../../providers/model-providers/model-provider-repository.ts";
import { AgentAdministration } from "./agent-administration.ts";
import { AgentRepository } from "./agent-repository.ts";

/** Agents run only on a model the workspace offers, which here is `OFFERED`. */
const OFFERED = "offered-model";

describe.skipIf(!process.env.DATABASE_URL)("choosing what agents run on", () => {
	let agents: Promised<AgentRepository.Interface>;
	let administration: Promised<AgentAdministration.Interface>;
	let workspaceId: string;
	let creatorId: string;
	let podId: string;

	beforeAll(async () => {
		agents = await servedOnPostgres(AgentRepository.Service, AgentRepository.layer);
		administration = await servedOnPostgres(AgentAdministration.Service, AgentAdministration.layer);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: stamp, slug: `models-${stamp}` })
				.returning(),
		);
		const [person] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Ada", email: `ada-${stamp}@example.com` })
				.returning(),
		);
		if (!space || !person) throw new Error("could not create the fixtures");
		workspaceId = space.id;
		creatorId = person.id;
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({ workspaceId, kind: "shared", name: "Support", slug: "support" })
				.returning(),
		);
		const [provider] = await onDatabase((db) =>
			db
				.insert(modelProvider)
				.values({
					workspaceId,
					name: "Models",
					baseUrl: "https://models.example/v1",
					apiFormat: "openai",
					active: true,
				})
				.returning(),
		);
		if (!room || !provider) throw new Error("could not create the fixtures");
		podId = room.id;
		await onDatabase((db) =>
			db.insert(providerModel).values([
				{ workspaceId, providerId: provider.id, modelId: OFFERED, enabled: true, source: "manual" },
				{ workspaceId, providerId: provider.id, modelId: "switched-off", source: "manual" },
			]),
		);
	});

	it("creates an agent on a model the workspace offers", async () => {
		const made = await administration.create({
			workspaceId,
			createdById: creatorId,
			agent: {
				podId,
				name: "Triage",
				model: OFFERED,
			},
		});

		expect(made.model).toBe(OFFERED);
	});

	it.each(["unknown-model", "switched-off"])(
		"refuses to create an agent on %s, and creates nothing",
		async (model) => {
			await expect(
				administration.create({
					workspaceId,
					createdById: creatorId,
					agent: { podId, name: "Triage", model },
				}),
			).rejects.toBeInstanceOf(ModelProviderRepository.ModelNotEnabled);

			expect(
				await onDatabase((db) => db.select().from(agent).where(eq(agent.podId, podId))),
			).toEqual([]);
		},
	);

	it("refuses to move an agent to a model the workspace does not offer, but lets it be cleared", async () => {
		const made = await administration.create({
			workspaceId,
			createdById: creatorId,
			agent: {
				podId,
				name: "Triage",
				model: OFFERED,
			},
		});

		await expect(
			administration.update({ workspaceId, agentId: made.id, changes: { model: "switched-off" } }),
		).rejects.toBeInstanceOf(ModelProviderRepository.ModelNotEnabled);
		expect(
			(await administration.update({ workspaceId, agentId: made.id, changes: { model: null } }))
				.model,
		).toBeNull();
	});

	it("refuses a change that changes nothing", async () => {
		const made = await administration.create({
			workspaceId,
			createdById: creatorId,
			agent: {
				podId,
				name: "Triage",
				model: OFFERED,
			},
		});

		await expect(
			administration.update({ workspaceId, agentId: made.id, changes: {} }),
		).rejects.toBeInstanceOf(AgentAdministration.EmptyAgentUpdate);
	});

	it("sets a system agent up only on a model the workspace offers", async () => {
		await agents.ensureSystemAgents({ workspaceId, createdById: creatorId });

		await expect(
			administration.setSystemAgentModel({ workspaceId, key: "summarise", model: "unknown-model" }),
		).rejects.toBeInstanceOf(ModelProviderRepository.ModelNotEnabled);
		expect(
			(await administration.setSystemAgentModel({ workspaceId, key: "summarise", model: OFFERED }))
				.model,
		).toBe(OFFERED);
	});
});
