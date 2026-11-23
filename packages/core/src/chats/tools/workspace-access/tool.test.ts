import { handleFromName, type WorkspaceRole } from "@sugabots/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bot, chatParticipant, membership, person, workspace } from "../../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../../database/testing.ts";
import { seedChat } from "../../seed.test-support.ts";
import { type WorkspaceAccessResult, workspaceAccessTool } from "./tool.ts";

describe.skipIf(!process.env.DATABASE_URL)("workspace_access, against Postgres", () => {
	let suffix: string;
	let workspaceId: string;
	let chatId: string;
	let owner: typeof person.$inferSelect;

	afterAll(async () => {
		await closeDatabase();
	});

	/** A person in the workspace with `role`, named so their handle is unique to this test. */
	async function personWithRole(name: string, role: WorkspaceRole) {
		const [somebody] = await onDatabase((db) =>
			db
				.insert(person)
				.values({ name: `${name} ${suffix}`, email: `${name}-${suffix}@example.com` })
				.returning(),
		);
		if (!somebody) throw new Error("Could not create a person");
		await onDatabase((db) =>
			db.insert(membership).values({ workspaceId, personId: somebody.id, role }),
		);
		return somebody;
	}

	async function joinChat(personId: string) {
		await onDatabase((db) => db.insert(chatParticipant).values({ chatId, personId }));
	}

	async function lookUp(person: string): Promise<WorkspaceAccessResult> {
		const lookUpTool = workspaceAccessTool({
			chatId,
			workspaceId,
			run: runOnPostgres,
		});
		const result = await lookUpTool.execute?.(
			{ person },
			{ toolCallId: "call", messages: [], context: {} },
		);
		return result as WorkspaceAccessResult;
	}

	const handleOf = (name: string) => handleFromName(`${name} ${suffix}`);

	beforeEach(async () => {
		suffix = crypto.randomUUID().slice(0, 8);
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Access workspace", slug: `access-${suffix}` })
				.returning(),
		);
		if (!space) throw new Error("Could not create a workspace");
		workspaceId = space.id;
		owner = await personWithRole("Owner", "owner");
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

	it("says a person's role and lists the owner first, then admins, as who can help", async () => {
		const viewer = await personWithRole("Viewer", "viewer");
		await personWithRole("Admin", "admin");
		await personWithRole("Bystander", "editor");
		await joinChat(viewer.id);

		expect(await lookUp(`@${handleOf("Viewer")}`)).toEqual({
			person: { name: viewer.name, handle: handleOf("Viewer"), role: "viewer" },
			canHelp: [
				{ name: `Owner ${suffix}`, handle: handleOf("Owner"), role: "owner" },
				{ name: `Admin ${suffix}`, handle: handleOf("Admin"), role: "admin" },
			],
			more: false,
		});
	});

	it("lists at most five who can help, and says when there are more", async () => {
		const asker = await personWithRole("Asker", "editor");
		await joinChat(asker.id);
		for (const index of [1, 2, 3, 4, 5]) await personWithRole(`Admin${index}`, "admin");

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
		const admin = await personWithRole("Admin", "admin");
		await personWithRole("Other", "admin");
		await joinChat(admin.id);

		expect(await lookUp(handleOf("Admin"))).toEqual({
			person: { name: admin.name, handle: handleOf("Admin"), role: "admin" },
			canHelp: [{ name: `Owner ${suffix}`, handle: handleOf("Owner"), role: "owner" }],
			more: false,
		});
	});

	it("lists nobody as who can change the owner's role", async () => {
		await personWithRole("Admin", "admin");
		await joinChat(owner.id);

		expect(await lookUp(handleOf("Owner"))).toEqual({
			person: { name: owner.name, handle: handleOf("Owner"), role: "owner" },
			canHelp: [],
			more: false,
		});
	});

	it("only looks up people in the chat", async () => {
		const asker = await personWithRole("Asker", "editor");
		await joinChat(asker.id);
		await personWithRole("Elsewhere", "admin");

		expect(await lookUp(handleOf("Elsewhere"))).toEqual({
			refused: expect.stringContaining(`@${handleOf("Asker")}`),
		});
	});

	it("says someone who has left the workspace has no role", async () => {
		const [former] = await onDatabase((db) =>
			db
				.insert(person)
				.values({ name: `Former ${suffix}`, email: `former-${suffix}@example.com` })
				.returning(),
		);
		if (!former) throw new Error("Could not create a person");
		await joinChat(former.id);

		expect(await lookUp(handleOf("Former"))).toMatchObject({
			person: { handle: handleOf("Former"), role: "none" },
		});
	});
});
