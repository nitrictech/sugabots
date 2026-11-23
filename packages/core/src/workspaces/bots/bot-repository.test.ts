import type { NewBot } from "@sugabots/contracts";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { noComputers } from "../../computers/testing.ts";
import { bot, user, workspace, workspaceMember } from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	servedOnPostgres,
} from "../../database/testing.ts";
import { servedOnPostgresAs } from "../testing.ts";
import { BotAdministration } from "./bot-administration.ts";
import { BotRepository } from "./bot-repository.ts";
import { INTERVIEW_PROMPT } from "./interview-prompt.ts";

describe.skipIf(!process.env.DATABASE_URL)("bots, against Postgres", () => {
	let repository: Promised<BotRepository.Interface>;
	let administrationAs: (userId: string) => Promised<BotAdministration.Interface>;
	let workspaceId: string;
	let adminId: string;
	let memberId: string;

	beforeAll(async () => {
		repository = await servedOnPostgres(BotRepository.Service, BotRepository.layer);
		administrationAs = await servedOnPostgresAs(
			BotAdministration.Service,
			BotAdministration.layer.pipe(Layer.provide(noComputers)),
		);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const create = (createdById: string, input: NewBot) =>
		repository.create(workspaceId, { createdById, bot: input });
	const visibleTo = (userId: string) => administrationAs(userId).list({ workspace: workspaceId });

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db.insert(workspace).values({ name: stamp, slug: stamp }).returning(),
		);
		if (!space) throw new Error("workspace setup failed");
		workspaceId = space.id;
		const [admin, member] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Ada", email: `ada-${stamp}@example.com` },
					{ name: "Sam", email: `sam-${stamp}@example.com` },
				])
				.returning(),
		);
		if (!admin || !member) throw new Error("user setup failed");
		adminId = admin.id;
		memberId = member.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: adminId, role: "admin" },
				{ workspaceId, userId: memberId, role: "member" },
			]),
		);
	});

	it("makes a bot public unless told otherwise, so every member sees it", async () => {
		const made = await create(adminId, { name: "Triage", model: "gpt-4o-mini" });

		expect(made.visibility).toBe("public");
		expect((await visibleTo(memberId)).map(({ id }) => id)).toEqual([made.id]);
	});

	it("lists a private bot to its creator and to admins, and to no other member", async () => {
		const adminsOwn = await create(adminId, {
			name: "Ledger",
			model: "model",
			visibility: "private",
		});
		const membersOwn = await create(memberId, {
			name: "Diary",
			model: "model",
			visibility: "private",
		});

		expect((await visibleTo(memberId)).map(({ id }) => id)).toEqual([membersOwn.id]);
		expect((await visibleTo(adminId)).map(({ id }) => id)).toEqual([membersOwn.id, adminsOwn.id]);
	});

	it("pins a bot for the person who made it, and for nobody else", async () => {
		const made = await create(memberId, { name: "Triage", model: "model" });

		expect((await visibleTo(memberId)).find(({ id }) => id === made.id)?.pinned).toBe(true);
		expect((await visibleTo(adminId)).find(({ id }) => id === made.id)?.pinned).toBe(false);
	});

	it("starts a bot made without a prompt on the interview", async () => {
		const made = await create(adminId, { name: "Triage", model: "gpt-4o-mini" });
		expect(made.prompt).toBe(INTERVIEW_PROMPT);
	});

	it("makes a bot nobody gave a shape a circle, and keeps the shape it's given", async () => {
		const plain = await create(adminId, { name: "Plain", model: "model" });
		const starred = await create(adminId, {
			name: "Starred",
			model: "model",
			shape: "star",
		});
		expect(plain.shape).toBe("circle");
		expect(starred.shape).toBe("star");

		const reshaped = await administrationAs(adminId).update({
			botId: plain.id,
			changes: { shape: "bear" },
		});
		expect(reshaped.shape).toBe("bear");
		expect((await visibleTo(adminId)).find((one) => one.id === plain.id)?.shape).toBe("bear");
	});

	it("refuses a name another bot in the workspace has", async () => {
		await create(adminId, { name: "Triage", model: "model" });
		await expect(create(adminId, { name: "Triage", model: "model" })).rejects.toMatchObject({
			_tag: "BotNameTaken",
			field: "name",
		});
	});

	it("refuses a handle another bot in the workspace has, as a clash rather than a fault", async () => {
		await create(adminId, { name: "Triage", model: "model" });

		await expect(
			create(adminId, { name: "Sorter", handle: "triage", model: "model" }),
		).rejects.toMatchObject({ _tag: "BotNameTaken", field: "handle" });
	});

	it("refuses @here and @channel as a handle, given or taken from the name", async () => {
		await expect(
			create(adminId, { name: "Sorter", handle: "here", model: "model" }),
		).rejects.toMatchObject({ _tag: "BotHandleReserved", handle: "here" });
		await expect(create(adminId, { name: "Channel", model: "model" })).rejects.toMatchObject({
			_tag: "BotHandleReserved",
			handle: "channel",
		});
		const sorter = await create(adminId, { name: "Sorter", model: "model" });
		await expect(
			repository.update(workspaceId, sorter.id, { handle: "channel" }, adminId),
		).rejects.toMatchObject({ _tag: "BotHandleReserved", handle: "channel" });
	});

	it("keeps the Personal Assistant's handle for Personal Assistants, given or taken from the name", async () => {
		await expect(
			create(adminId, { name: "Personal Assistant", model: "model" }),
		).rejects.toMatchObject({ _tag: "BotHandleReserved", handle: "personal-assistant" });
		const sorter = await create(adminId, { name: "Sorter", model: "model" });
		await expect(
			repository.update(workspaceId, sorter.id, { handle: "personal-assistant" }, adminId),
		).rejects.toMatchObject({ _tag: "BotHandleReserved", handle: "personal-assistant" });
	});

	it("says which name a renaming clashes on", async () => {
		await create(adminId, { name: "Triage", model: "model" });
		const other = await create(adminId, { name: "Sorter", model: "model" });

		await expect(
			repository.update(workspaceId, other.id, { name: "Triage" }, adminId),
		).rejects.toMatchObject({
			_tag: "BotNameTaken",
			field: "name",
			value: "Triage",
		});
	});

	it("lets a bot's model be cleared, which stops it rather than breaking it", async () => {
		const made = await create(adminId, {
			name: "Clearable",
			model: "model",
		});

		const cleared = await repository.update(workspaceId, made.id, { model: null }, adminId);

		expect(cleared.model).toBeNull();
		// Still listed: it simply cannot take a turn.
		const visible = await visibleTo(adminId);
		expect(visible.map((one) => one.name)).toContain("Clearable");
	});

	it("lets every person's Personal Assistant have the same name", async () => {
		const admins = await repository.provisionPersonalAssistant({ workspaceId, userId: adminId });
		const members = await repository.provisionPersonalAssistant({ workspaceId, userId: memberId });

		expect(members.name).toBe(admins.name);
		expect(members.id).not.toBe(admins.id);
	});

	it("does not individually delete a system bot", async () => {
		const system = await placeCompaction();
		await expect(
			repository.remove(workspaceId, system.id, adminId, Effect.void),
		).rejects.toBeInstanceOf(BotRepository.SystemBotImmutable);
	});

	it("does not change a system bot as a bot people talk to", async () => {
		const system = await placeCompaction();
		await expect(
			repository.update(workspaceId, system.id, { model: "another" }, adminId),
		).rejects.toBeInstanceOf(BotRepository.SystemBotImmutable);
	});

	it("leaves system bots out of the list", async () => {
		await placeCompaction();
		await create(adminId, { name: "Triage", model: "model" });
		const visible = await visibleTo(adminId);
		expect(visible.map((one) => one.name)).not.toContain("Compaction");
		expect(visible.map((one) => one.name)).toContain("Triage");
	});

	/** The workspace's Compaction bot, with no model until somebody chooses one. */
	async function placeCompaction() {
		const [system] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId,
					name: "Compaction",
					handle: "compaction",
					systemBotKey: "compact",
					color: "purple",
					face: "square",
					model: null,
				})
				.returning(),
		);
		if (!system) throw new Error("system bot setup failed");
		return system;
	}
});
