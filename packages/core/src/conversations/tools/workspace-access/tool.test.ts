import { handleFromName, type WorkspaceRole } from "@sugabots/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	agent,
	pod,
	thread,
	threadParticipant,
	user,
	workspace,
	workspaceMember,
} from "../../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../../database/testing.ts";
import { type WorkspaceAccessResult, workspaceAccessTool } from "./tool.ts";

describe.skipIf(!process.env.DATABASE_URL)("workspace_access, against Postgres", () => {
	let suffix: string;
	let workspaceId: string;
	let threadId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	/** A workspace member with `role`, named so their handle is unique to this test. */
	async function member(name: string, role: WorkspaceRole) {
		const [person] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: `${name} ${suffix}`, email: `${name}-${suffix}@example.com` })
				.returning(),
		);
		if (!person) throw new Error("Could not create a member");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: person.id, role }),
		);
		return person;
	}

	async function joinThread(userId: string) {
		await onDatabase((db) => db.insert(threadParticipant).values({ threadId, userId }));
	}

	async function lookUp(person: string): Promise<WorkspaceAccessResult> {
		const lookUpTool = workspaceAccessTool({ threadId, workspaceId, run: runOnPostgres });
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
		const owner = await member("Owner", "owner");
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					ownerId: owner.id,
					kind: "shared",
					name: "Access pod",
					slug: `access-${suffix}`,
					createdById: owner.id,
				})
				.returning(),
		);
		if (!room) throw new Error("Could not create a pod");
		const [host] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId: room.id,
					name: "Helper",
					handle: handleFromName(`Helper ${suffix}`),
					color: "green",
					face: "pill",
					model: "test/model",
					createdById: owner.id,
				})
				.returning(),
		);
		if (!host) throw new Error("Could not create an agent");
		const [created] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId,
					podId: room.id,
					hostAgentId: host.id,
					type: "chat",
					title: "Access",
				})
				.returning(),
		);
		if (!created) throw new Error("Could not create a thread");
		threadId = created.id;
	});

	it("says a person's role and lists the owner first, then admins, as who can help", async () => {
		const viewer = await member("Viewer", "viewer");
		await member("Admin", "admin");
		await member("Bystander", "member");
		await joinThread(viewer.id);

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
		const asker = await member("Asker", "member");
		await joinThread(asker.id);
		for (const index of [1, 2, 3, 4, 5]) await member(`Admin${index}`, "admin");

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

	it("only looks up people in the thread", async () => {
		const asker = await member("Asker", "member");
		await joinThread(asker.id);
		await member("Elsewhere", "admin");

		expect(await lookUp(handleOf("Elsewhere"))).toEqual({
			refused: expect.stringContaining(`@${handleOf("Asker")}`),
		});
	});

	it("says someone who has left the workspace has no role", async () => {
		const [former] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: `Former ${suffix}`, email: `former-${suffix}@example.com` })
				.returning(),
		);
		if (!former) throw new Error("Could not create a person");
		await joinThread(former.id);

		expect(await lookUp(handleOf("Former"))).toMatchObject({
			person: { handle: handleOf("Former"), role: "none" },
		});
	});
});
