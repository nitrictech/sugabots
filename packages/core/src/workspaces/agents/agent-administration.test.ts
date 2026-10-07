import { PERSONAL_POD_SLUG } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionForbidden, ResourceHidden } from "../../authorization/access.ts";
import {
	agent,
	modelProvider,
	pod,
	podMember,
	providerModel,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	servedOnPostgres,
} from "../../database/testing.ts";
import { ModelProviderRepository } from "../../providers/model-providers/model-provider-repository.ts";
import { servedOnPostgresAs } from "../testing.ts";
import { AgentAdministration } from "./agent-administration.ts";
import { AgentRepository } from "./agent-repository.ts";

/** Agents run only on a model the workspace offers, which here is `OFFERED`. */
const OFFERED = "offered-model";

describe.skipIf(!process.env.DATABASE_URL)("choosing what agents run on", () => {
	let agents: Promised<AgentRepository.Interface>;
	let administrationAs: (userId: string) => Promised<AgentAdministration.Interface>;
	/** The administration as the workspace's administrator. */
	let administration: Promised<AgentAdministration.Interface>;
	let workspaceId: string;
	let creatorId: string;
	let podId: string;

	beforeAll(async () => {
		agents = await servedOnPostgres(AgentRepository.Service, AgentRepository.layer);
		administrationAs = await servedOnPostgresAs(
			AgentAdministration.Service,
			AgentAdministration.layer,
		);
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
		administration = administrationAs(creatorId);
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: creatorId, role: "admin" }),
		);
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
			podId,
			agent: {
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
				administration.create({ podId, agent: { name: "Triage", model } }),
			).rejects.toBeInstanceOf(ModelProviderRepository.ModelNotEnabled);

			expect(
				await onDatabase((db) => db.select().from(agent).where(eq(agent.podId, podId))),
			).toEqual([]);
		},
	);

	it("refuses to move an agent to a model the workspace does not offer, but lets it be cleared", async () => {
		const made = await administration.create({
			podId,
			agent: {
				name: "Triage",
				model: OFFERED,
			},
		});

		await expect(
			administration.update({ agentId: made.id, changes: { model: "switched-off" } }),
		).rejects.toBeInstanceOf(ModelProviderRepository.ModelNotEnabled);
		expect(
			(await administration.update({ agentId: made.id, changes: { model: null } })).model,
		).toBeNull();
	});

	it("refuses a change that changes nothing", async () => {
		const made = await administration.create({
			podId,
			agent: {
				name: "Triage",
				model: OFFERED,
			},
		});

		await expect(administration.update({ agentId: made.id, changes: {} })).rejects.toBeInstanceOf(
			AgentAdministration.EmptyAgentUpdate,
		);
	});

	it("sets a system agent up only on a model the workspace offers", async () => {
		await agents.ensureSystemAgents({ workspaceId, createdById: creatorId });

		await expect(
			administration.setSystemAgentModel({
				workspace: workspaceId,
				key: "summarise",
				model: "unknown-model",
			}),
		).rejects.toBeInstanceOf(ModelProviderRepository.ModelNotEnabled);
		expect(
			(
				await administration.setSystemAgentModel({
					workspace: workspaceId,
					key: "summarise",
					model: OFFERED,
				})
			).model,
		).toBe(OFFERED);
	});

	it("refuses what the pod does not let somebody do, and hides it from who cannot reach it", async () => {
		const made = await administration.create({ podId, agent: { name: "Triage", model: OFFERED } });
		const [viewer, stranger] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Lee", email: `lee-${crypto.randomUUID()}@example.com` },
					{ name: "Kim", email: `kim-${crypto.randomUUID()}@example.com` },
				])
				.returning(),
		);
		if (!viewer || !stranger) throw new Error("could not create the people");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: viewer.id, role: "viewer" }),
		);
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId, podId, userId: viewer.id }),
		);

		await expect(
			administrationAs(viewer.id).create({ podId, agent: { name: "Scout", model: OFFERED } }),
		).rejects.toBeInstanceOf(ActionForbidden);
		await expect(
			administrationAs(viewer.id).setSystemAgentModel({
				workspace: workspaceId,
				key: "summarise",
				model: OFFERED,
			}),
		).rejects.toBeInstanceOf(ActionForbidden);
		expect(await administrationAs(viewer.id).get({ agentId: made.id })).toMatchObject({
			id: made.id,
		});
		await expect(administrationAs(stranger.id).get({ agentId: made.id })).rejects.toBeInstanceOf(
			ResourceHidden,
		);
		await expect(administrationAs(stranger.id).remove({ agentId: made.id })).rejects.toBeInstanceOf(
			ResourceHidden,
		);
	});

	it("lets only somebody who may manage the pod's sandbox let an agent use it", async () => {
		const [member] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Lee", email: `lee-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!member) throw new Error("could not create the member");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: member.id, role: "member" }),
		);
		await onDatabase((db) =>
			db.insert(podMember).values({ workspaceId, podId, userId: member.id }),
		);
		const asMember = administrationAs(member.id);

		await expect(
			asMember.create({ podId, agent: { name: "Scout", model: OFFERED, usesSandbox: true } }),
		).rejects.toBeInstanceOf(ActionForbidden);
		const made = await asMember.create({ podId, agent: { name: "Triage", model: OFFERED } });
		await expect(
			asMember.update({ agentId: made.id, changes: { usesSandbox: true } }),
		).rejects.toBeInstanceOf(ActionForbidden);
		expect(
			(await administration.update({ agentId: made.id, changes: { usesSandbox: true } }))
				.usesSandbox,
		).toBe(true);
		await expect(
			asMember.update({ agentId: made.id, changes: { usesSandbox: false } }),
		).rejects.toBeInstanceOf(ActionForbidden);
	});

	describe("in a pod the actor is not in", () => {
		/** Sam, a member with a Personal pod holding an agent of his own. */
		const aMemberWithPersonalAgent = async () => {
			const [person] = await onDatabase((db) =>
				db
					.insert(user)
					.values({ name: "Sam", email: `sam-${crypto.randomUUID()}@example.com` })
					.returning(),
			);
			if (!person) throw new Error("could not create the member");
			await onDatabase((db) =>
				db.insert(workspaceMember).values({ workspaceId, userId: person.id, role: "member" }),
			);
			const [personal] = await onDatabase((db) =>
				db
					.insert(pod)
					.values({
						workspaceId,
						kind: "personal",
						ownerId: person.id,
						name: "Personal",
						slug: PERSONAL_POD_SLUG,
					})
					.returning(),
			);
			if (!personal) throw new Error("could not create the Personal pod");
			await onDatabase((db) =>
				db.insert(podMember).values({ workspaceId, podId: personal.id, userId: person.id }),
			);
			const made = await administrationAs(person.id).create({
				podId: personal.id,
				agent: { name: "Helper", model: OFFERED },
			});
			return { memberId: person.id, agentId: made.id };
		};

		it("lets an administrator change and remove a shared pod's agent without joining it", async () => {
			const made = await administration.create({
				podId,
				agent: { name: "Triage", model: OFFERED },
			});

			expect(
				await administration.update({ agentId: made.id, changes: { name: "Sorter" } }),
			).toMatchObject({ id: made.id, name: "Sorter" });
			await administration.remove({ agentId: made.id });

			expect(
				await onDatabase((db) => db.select().from(agent).where(eq(agent.id, made.id))),
			).toEqual([]);
		});

		it("hides an agent in somebody else's Personal pod from an administrator", async () => {
			const { agentId } = await aMemberWithPersonalAgent();

			await expect(administration.get({ agentId })).rejects.toBeInstanceOf(ResourceHidden);
			await expect(
				administration.update({ agentId, changes: { name: "Mine now" } }),
			).rejects.toBeInstanceOf(ResourceHidden);
			await expect(administration.remove({ agentId })).rejects.toBeInstanceOf(ResourceHidden);
		});

		it("lets the owner of a Personal pod remove its agent", async () => {
			const { memberId, agentId } = await aMemberWithPersonalAgent();

			await administrationAs(memberId).remove({ agentId });

			expect(
				await onDatabase((db) => db.select().from(agent).where(eq(agent.id, agentId))),
			).toEqual([]);
		});
	});
});
