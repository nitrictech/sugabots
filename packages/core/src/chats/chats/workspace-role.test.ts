import { handleFromName, type WorkspaceRole } from "@sugabots/contracts";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedTurnAnswering } from "../../authentication/seed.test-support.ts";
import { TurnAuthentication } from "../../authentication/turn.ts";
import { bot, chatParticipant, type member } from "../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../database/testing.ts";
import { createTestMember, createTestWorkspace } from "../../database/workspace.test-support.ts";
import { type CallOperation, servedOperations } from "../../operations/testing.ts";
import { seedChat } from "../seed.test-support.ts";

describe.skipIf(!process.env.DATABASE_URL)("workspace_role, against Postgres", () => {
	let suffix: string;
	let workspaceId: string;
	let chatId: string;
	let owner: typeof member.$inferSelect;
	let botId: string;
	let call: CallOperation;
	let authentication: TurnAuthentication.Interface;

	beforeAll(async () => {
		call = await servedOperations();
		authentication = await runOnPostgres(
			Effect.provide(TurnAuthentication.Service, TurnAuthentication.layer),
		);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** A member in the workspace with `role`, named so their handle is unique to this test. */
	async function memberWithRole(name: string, role: WorkspaceRole) {
		const somebody = await createTestMember(
			{ name: `${name} ${suffix}`, email: `${name}-${suffix}@example.com` },
			{ workspaceId, role },
		);
		return somebody;
	}

	async function joinChat(memberId: string) {
		await onDatabase((db) => db.insert(chatParticipant).values({ chatId, memberId }));
	}

	async function lookUp(member: string) {
		const turnId = await seedTurnAnswering(chatId, botId, { member: owner.id });
		const principal = await runOnPostgres(authentication.authenticate(turnId));
		return call(principal, "chats.workspaceRole", { member });
	}

	const handleOf = (name: string) => handleFromName(`${name} ${suffix}`);

	beforeEach(async () => {
		suffix = crypto.randomUUID().slice(0, 8);
		const space = await createTestWorkspace({ name: "Access workspace", slug: `access-${suffix}` });
		workspaceId = space.id;
		owner = await memberWithRole("Owner", "owner");
		const [host] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId,
					name: "Helper",
					handle: handleFromName(`Helper ${suffix}`),
					color: "green",
					eyes: "pill",
					model: "test/model",
					createdById: owner.id,
				})
				.returning(),
		);
		if (!host) throw new Error("Could not create a bot");
		botId = host.id;
		const created = await onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "project_chat",
				botId: host.id,
				title: "Access",
				startedById: owner.id,
			}),
		);
		chatId = created.id;
	});

	it("says a member's role and lists the owner first, then admins, as who can help", async () => {
		const viewer = await memberWithRole("Viewer", "viewer");
		await memberWithRole("Admin", "admin");
		await memberWithRole("Bystander", "editor");
		await joinChat(viewer.id);

		expect(await lookUp(`@${handleOf("Viewer")}`)).toEqual({
			member: { name: viewer.name, handle: handleOf("Viewer"), role: "viewer" },
			canHelp: [
				{ name: `Owner ${suffix}`, handle: handleOf("Owner"), role: "owner" },
				{ name: `Admin ${suffix}`, handle: handleOf("Admin"), role: "admin" },
			],
			more: false,
		});
	});

	it("lists at most five who can help, and says when there are more", async () => {
		const asker = await memberWithRole("Asker", "editor");
		await joinChat(asker.id);
		for (const index of [1, 2, 3, 4, 5]) await memberWithRole(`Admin${index}`, "admin");

		const result = await lookUp(handleOf("Asker"));

		expect(result).toMatchObject({ more: true });
		expect("canHelp" in result && result.canHelp.map((helper) => helper.role)).toEqual([
			"owner",
			"admin",
			"admin",
			"admin",
			"admin",
		]);
	});

	it("lists only the owner as who can change an admin's role", async () => {
		const admin = await memberWithRole("Admin", "admin");
		await memberWithRole("Other", "admin");
		await joinChat(admin.id);

		expect(await lookUp(handleOf("Admin"))).toEqual({
			member: { name: admin.name, handle: handleOf("Admin"), role: "admin" },
			canHelp: [{ name: `Owner ${suffix}`, handle: handleOf("Owner"), role: "owner" }],
			more: false,
		});
	});

	it("lists nobody as who can change the owner's role", async () => {
		await memberWithRole("Admin", "admin");
		await joinChat(owner.id);

		expect(await lookUp(handleOf("Owner"))).toEqual({
			member: { name: owner.name, handle: handleOf("Owner"), role: "owner" },
			canHelp: [],
			more: false,
		});
	});

	it("only looks up members taking part in the chat", async () => {
		const asker = await memberWithRole("Asker", "editor");
		await joinChat(asker.id);
		await memberWithRole("Elsewhere", "admin");

		expect(await lookUp(handleOf("Elsewhere"))).toEqual({
			refused: expect.stringContaining(`@${handleOf("Asker")}`),
		});
	});

	it("says someone who has left the workspace has no role", async () => {
		const former = await createTestMember({
			name: `Former ${suffix}`,
			email: `former-${suffix}@example.com`,
		});
		await joinChat(former.id);

		expect(await lookUp(handleOf("Former"))).toMatchObject({
			member: { handle: handleOf("Former"), role: "none" },
		});
	});
});
