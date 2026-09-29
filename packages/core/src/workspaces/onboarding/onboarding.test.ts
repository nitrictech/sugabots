import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ActionForbidden } from "../../authorization/access.ts";
import { CurrentActor } from "../../authorization/current-actor.ts";
import {
	agent,
	modelProvider,
	pod,
	providerModel,
	user,
	workspace,
	workspaceDefaultModel,
	workspaceInvite,
	workspaceMember,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../database/testing.ts";
import { onPostgresAs } from "../testing.ts";
import { Onboarding } from "./onboarding.ts";

describe.skipIf(!process.env.DATABASE_URL)("onboarding, against Postgres", () => {
	let onboarding: Onboarding.Interface;
	let workspaceId: string;
	let adminId: string;
	let memberId: string;
	let memberEmail: string;
	let podId: string;
	let customAgentId: string;
	let systemAgentId: string;

	beforeAll(async () => {
		onboarding = await runOnPostgres(Effect.provide(Onboarding.Service, Onboarding.layer));
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const as = (userId: string) =>
		onPostgresAs(userId)({
			complete: onboarding.complete,
			completeAcceptedInvite: onboarding.completeAcceptedInvite,
		});
	const complete = (userId: string, agentId: string) =>
		as(userId).complete({ workspaceId, podId, agentId });
	const isCompleted = (userId: string) =>
		runOnPostgres(
			onboarding.isCompleted.pipe(
				CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId)),
			),
		);

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [madeWorkspace] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Test ${stamp}`, slug: `onboarding-${stamp}` })
				.returning(),
		);
		const people = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Admin", email: `admin-${stamp}@example.com` },
					{ name: "Member", email: `member-${stamp}@example.com` },
				])
				.returning(),
		);
		const [admin, member] = people;
		if (!madeWorkspace || !admin || !member)
			throw new Error("could not create onboarding fixtures");
		workspaceId = madeWorkspace.id;
		adminId = admin.id;
		memberId = member.id;
		memberEmail = member.email;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: adminId, role: "admin" },
				{ workspaceId, userId: memberId, role: "member" },
			]),
		);
		const [madePod] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					ownerId: adminId,
					kind: "shared",
					name: "Product",
					slug: "product",
					createdById: adminId,
				})
				.returning(),
		);
		if (!madePod) throw new Error("could not create onboarding pod");
		podId = madePod.id;
		const [provider] = await onDatabase((db) =>
			db
				.insert(modelProvider)
				.values({
					workspaceId,
					preset: null,
					name: "Test provider",
					baseUrl: "https://models.example.com",
					apiFormat: "openai",
					active: true,
					createdById: adminId,
				})
				.returning(),
		);
		if (!provider) throw new Error("could not create model provider");
		await onDatabase((db) =>
			db.insert(providerModel).values({
				workspaceId,
				providerId: provider.id,
				modelId: "model",
				enabled: true,
				source: "manual",
			}),
		);
		const madeAgents = await onDatabase((db) =>
			db
				.insert(agent)
				.values([
					{
						workspaceId,
						podId,
						name: "Coordinator",
						handle: "coordinator",
						color: "green",
						face: "pill",
						model: "model",
						createdById: adminId,
					},
					{
						workspaceId,
						// The workspace's Scribe, in no pod and with no model until the
						// workspace settles on one.
						podId: null,
						name: "Scribe",
						handle: "scribe",
						systemAgentKey: "summarise",
						color: "orange",
						face: "arc",
						model: null,
						createdById: adminId,
					},
				])
				.returning(),
		);
		const [custom, system] = madeAgents;
		if (!custom || !system) throw new Error("could not create onboarding agents");
		customAgentId = custom.id;
		systemAgentId = system.id;
	});

	it("completes only for an admin's custom agent in their pod", async () => {
		await complete(adminId, customAgentId);

		expect(await isCompleted(adminId)).toBe(true);
	});

	it("does not complete for an agent with no model the workspace offers", async () => {
		await onDatabase((db) =>
			db.update(agent).set({ model: "not-switched-on" }).where(eq(agent.id, customAgentId)),
		);
		await expect(complete(adminId, customAgentId)).rejects.toBeInstanceOf(Onboarding.NoModelChosen);

		await onDatabase((db) =>
			db.update(agent).set({ model: null }).where(eq(agent.id, customAgentId)),
		);
		await expect(complete(adminId, customAgentId)).rejects.toBeInstanceOf(Onboarding.NoModelChosen);
		expect(await isCompleted(adminId)).toBe(false);
	});

	it("makes the first bot's model the workspace's default and the Scribe's", async () => {
		await complete(adminId, customAgentId);

		const [scribe] = await onDatabase((db) =>
			db.select({ model: agent.model }).from(agent).where(eq(agent.id, systemAgentId)),
		);
		expect(scribe?.model).toBe("model");
		const [chosen] = await onDatabase((db) =>
			db
				.select({ modelId: workspaceDefaultModel.modelId })
				.from(workspaceDefaultModel)
				.where(eq(workspaceDefaultModel.workspaceId, workspaceId)),
		);
		expect(chosen?.modelId).toBe("model");
	});

	it("does not accept a system agent or a member who may not choose the workspace's models", async () => {
		await expect(complete(adminId, systemAgentId)).rejects.toBeInstanceOf(
			Onboarding.NotReadyToFinish,
		);
		await expect(complete(memberId, customAgentId)).rejects.toBeInstanceOf(ActionForbidden);
		expect(await isCompleted(adminId)).toBe(false);
	});

	it("completes an account from its accepted invitation", async () => {
		// A workspace people are invited into has been set up, so it has a default.
		await onDatabase((db) =>
			db.insert(workspaceDefaultModel).values({ workspaceId, modelId: "model" }),
		);
		const [invitation] = await onDatabase((db) =>
			db
				.insert(workspaceInvite)
				.values({
					workspaceId,
					email: memberEmail,
					role: "member",
					status: "accepted",
					inviterId: adminId,
					expiresAt: new Date(Date.now() + 60_000),
				})
				.returning(),
		);
		if (!invitation) throw new Error("could not create invitation");

		expect(await as(memberId).completeAcceptedInvite({ invitationId: invitation.id })).toBe(
			workspaceId,
		);
		expect(await isCompleted(memberId)).toBe(true);
		const [assistant] = await onDatabase((db) =>
			db
				.select({ model: agent.model })
				.from(agent)
				.innerJoin(pod, eq(pod.id, agent.podId))
				.where(and(eq(pod.ownerId, memberId), eq(agent.provisionedKey, "personal-assistant"))),
		);
		expect(assistant?.model).toBe("model");
	});

	it("refuses an invitation this account has not accepted", async () => {
		await expect(
			as(memberId).completeAcceptedInvite({ invitationId: crypto.randomUUID() }),
		).rejects.toBeInstanceOf(Onboarding.InvitationNotAccepted);
		expect(await isCompleted(memberId)).toBe(false);
	});
});
