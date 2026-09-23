import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, getDb } from "../../database/client.ts";
import {
	agent,
	modelProvider,
	pod,
	podMember,
	providerModel,
	user,
	workspace,
	workspaceInvite,
	workspaceMember,
} from "../../database/schema.ts";
import { closeDatabase, onPostgres } from "../../database/testing.ts";
import { onboardingStore } from "./store.ts";

describe.skipIf(!process.env.DATABASE_URL)("onboarding, against Postgres", () => {
	const db = getDb();
	const store = onPostgres(onboardingStore);
	let workspaceId: string;
	let adminId: string;
	let memberId: string;
	let memberEmail: string;
	let podId: string;
	let customAgentId: string;
	let systemAgentId: string;

	afterAll(async () => {
		await closeDatabase();
		await closePool();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [madeWorkspace] = await db
			.insert(workspace)
			.values({ name: `Test ${stamp}`, slug: `onboarding-${stamp}` })
			.returning();
		const people = await db
			.insert(user)
			.values([
				{ name: "Admin", email: `admin-${stamp}@example.com` },
				{ name: "Member", email: `member-${stamp}@example.com` },
			])
			.returning();
		const [admin, member] = people;
		if (!madeWorkspace || !admin || !member)
			throw new Error("could not create onboarding fixtures");
		workspaceId = madeWorkspace.id;
		adminId = admin.id;
		memberId = member.id;
		memberEmail = member.email;
		await db.insert(workspaceMember).values([
			{ workspaceId, userId: adminId, role: "admin" },
			{ workspaceId, userId: memberId, role: "member" },
		]);
		const [madePod] = await db
			.insert(pod)
			.values({
				workspaceId,
				ownerId: adminId,
				kind: "shared",
				name: "Product",
				slug: "product",
				createdById: adminId,
			})
			.returning();
		if (!madePod) throw new Error("could not create onboarding pod");
		podId = madePod.id;
		await db.insert(podMember).values({ workspaceId, podId, userId: adminId });
		const [provider] = await db
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
			.returning();
		if (!provider) throw new Error("could not create model provider");
		await db.insert(providerModel).values({
			workspaceId,
			providerId: provider.id,
			modelId: "model",
			enabled: true,
			source: "manual",
		});
		const madeAgents = await db
			.insert(agent)
			.values([
				{
					workspaceId,
					podId,
					name: "Coordinator",
					handle: "coordinator",
					hue: 120,
					face: "bar",
					model: "model",
					createdById: adminId,
				},
				{
					workspaceId,
					// The workspace's Scribe, in no pod and with no model until an
					// administrator chooses one on the Built-in agents screen.
					podId: null,
					name: "Scribe",
					handle: "scribe",
					systemAgentKey: "summarise",
					hue: 36,
					face: "smile",
					model: null,
					createdById: adminId,
				},
			])
			.returning();
		const [custom, system] = madeAgents;
		if (!custom || !system) throw new Error("could not create onboarding agents");
		customAgentId = custom.id;
		systemAgentId = system.id;
	});

	it("completes only for an admin's custom agent in their pod", async () => {
		expect(await store.complete(adminId, workspaceId, podId, customAgentId)).toBe(true);
		expect(await store.isCompleted(adminId)).toBe(true);
	});

	it("leaves the Scribe unset, so nobody is given a model they were not shown", async () => {
		await store.complete(adminId, workspaceId, podId, customAgentId);

		const [scribe] = await db
			.select({ model: agent.model })
			.from(agent)
			.where(eq(agent.id, systemAgentId));
		expect(scribe?.model).toBeNull();
	});

	it("does not accept a system agent or a non-admin member", async () => {
		expect(await store.complete(adminId, workspaceId, podId, systemAgentId)).toBe(false);
		expect(await store.complete(memberId, workspaceId, podId, customAgentId)).toBe(false);
		expect(await store.isCompleted(adminId)).toBe(false);
	});

	it("completes an account from its accepted invitation", async () => {
		const [invitation] = await db
			.insert(workspaceInvite)
			.values({
				workspaceId,
				email: memberEmail,
				role: "member",
				status: "accepted",
				inviterId: adminId,
				expiresAt: new Date(Date.now() + 60_000),
			})
			.returning();
		if (!invitation) throw new Error("could not create invitation");

		expect(await store.completeAcceptedInvite(memberId, invitation.id)).toBe(workspaceId);
		expect(await store.isCompleted(memberId)).toBe(true);
	});
});
