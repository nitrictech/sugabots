import type { NewBot } from "@sugabots/contracts";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bot } from "../../database/schema.ts";
import {
	closeDatabase,
	holdTransaction,
	onDatabase,
	type Promised,
	servedOnPostgres,
} from "../../database/testing.ts";
import { createWorkspaceFixture } from "../../database/workspace.test-support.ts";
import { type CallOperation, servedOperations } from "../../operations/testing.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";
import { BotStore } from "./bot-store.ts";
import { INTERVIEW_PROMPT } from "./interview-prompt.ts";

describe.skipIf(!process.env.DATABASE_URL)("bots, against Postgres", () => {
	let repository: Promised<BotStore.Interface>;
	let callOperation: CallOperation;
	let signedIn: ReturnType<typeof principals>;
	let workspaceId: string;
	let adminId: string;
	let editorId: string;

	beforeAll(async () => {
		repository = await servedOnPostgres(BotStore.Service, BotStore.layer);
		callOperation = await servedOperations();
		signedIn = principals(await authenticators());
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const create = (createdById: string, input: NewBot) =>
		repository.create(workspaceId, { createdById, bot: input });
	const visibleTo = async (memberId: string) =>
		callOperation(await signedIn.member(memberId), "bots.list", { workspace: workspaceId });

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const {
			workspace: space,
			members: { admin, editor },
		} = await createWorkspaceFixture(
			{ name: stamp, slug: stamp },
			{
				admin: { name: "Ada", email: `ada-${stamp}@example.com`, role: "admin" },
				editor: { name: "Sam", email: `sam-${stamp}@example.com`, role: "editor" },
			},
		);
		workspaceId = space.id;
		adminId = admin.id;
		editorId = editor.id;
	});

	it("makes a bot public unless told otherwise, so everyone in the workspace sees it", async () => {
		const made = await create(adminId, { name: "Triage", model: "gpt-4o-mini" });

		expect(made.visibility).toBe("public");
		expect((await visibleTo(editorId)).map(({ id }) => id)).toEqual([made.id]);
	});

	it("lists a personal bot to its creator and to admins, and to nobody else", async () => {
		const adminsOwn = await create(adminId, {
			name: "Ledger",
			model: "model",
			visibility: "personal",
		});
		const editorsOwn = await create(editorId, {
			name: "Diary",
			model: "model",
			visibility: "personal",
		});

		expect((await visibleTo(editorId)).map(({ id }) => id)).toEqual([editorsOwn.id]);
		expect((await visibleTo(adminId)).map(({ id }) => id)).toEqual([editorsOwn.id, adminsOwn.id]);
	});

	it("pins a bot for the member who made it, and for nobody else", async () => {
		const made = await create(editorId, { name: "Triage", model: "model" });

		expect((await visibleTo(editorId)).find(({ id }) => id === made.id)?.pinned).toBe(true);
		expect((await visibleTo(adminId)).find(({ id }) => id === made.id)?.pinned).toBe(false);
	});

	it("starts a bot made without a prompt on the interview", async () => {
		const made = await create(adminId, { name: "Triage", model: "gpt-4o-mini" });
		expect(made.instructions).toBe(INTERVIEW_PROMPT);
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

		const reshaped = await callOperation(await signedIn.member(adminId), "bots.update", {
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
			repository.update(workspaceId, sorter.id, { handle: "channel" }),
		).rejects.toMatchObject({ _tag: "BotHandleReserved", handle: "channel" });
	});

	it("keeps Personal Assistants' handles for Personal Assistants, given or taken from the name", async () => {
		await expect(
			create(adminId, { name: "Personal Assistant", model: "model" }),
		).rejects.toMatchObject({ _tag: "BotHandleReserved", handle: "personal-assistant" });
		await expect(
			create(adminId, { name: "Personal Assistant 2", model: "model" }),
		).rejects.toMatchObject({ _tag: "BotHandleReserved", handle: "personal-assistant-2" });
		const sorter = await create(adminId, { name: "Sorter", model: "model" });
		await expect(
			repository.update(workspaceId, sorter.id, { handle: "personal-assistant" }),
		).rejects.toMatchObject({ _tag: "BotHandleReserved", handle: "personal-assistant" });
	});

	it("never makes a bot personal, nor a personal one public, however it is asked", async () => {
		const publicBot = await create(adminId, { name: "Sorter", model: "model" });
		const personalBot = await create(adminId, {
			name: "Diary",
			model: "model",
			visibility: "personal",
		});

		await expect(
			repository.update(workspaceId, publicBot.id, { visibility: "personal" }),
		).rejects.toBeInstanceOf(BotStore.PersonalVisibilityFixed);
		await expect(
			repository.update(workspaceId, personalBot.id, { visibility: "public" }),
		).rejects.toBeInstanceOf(BotStore.PersonalVisibilityFixed);
		expect(
			await repository.update(workspaceId, publicBot.id, { visibility: "public" }),
		).toMatchObject({
			visibility: "public",
		});
	});

	it("says which name a renaming clashes on", async () => {
		await create(adminId, { name: "Triage", model: "model" });
		const other = await create(adminId, { name: "Sorter", model: "model" });

		await expect(
			repository.update(workspaceId, other.id, { name: "Triage" }),
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

		const cleared = await repository.update(workspaceId, made.id, { model: null });

		expect(cleared.model).toBeNull();
		// Still listed: it simply cannot take a turn.
		const visible = await visibleTo(adminId);
		expect(visible.map((one) => one.name)).toContain("Clearable");
	});

	it("lets every member's Personal Assistant have the same name", async () => {
		const admins = await repository.ensurePersonalAssistant({ workspaceId, memberId: adminId });
		const editors = await repository.ensurePersonalAssistant({ workspaceId, memberId: editorId });

		expect(editors.name).toBe(admins.name);
		expect(editors.id).not.toBe(admins.id);
	});

	it("makes a member one Personal Assistant when a second call asks while the first is making it", async () => {
		const member = { workspaceId, memberId: editorId };
		const first = holdTransaction(
			Effect.flatMap(BotStore.Service, (bots) => bots.ensurePersonalAssistant(member)).pipe(
				Effect.provide(BotStore.layer),
			),
		);
		const made = await first.held;
		const second = repository.ensurePersonalAssistant(member);
		try {
			// The second waits for the first to commit, or settles on its own;
			// either way the first commits only once the second has asked.
			await Promise.race([
				first.waitForWaiters(1),
				second.then(
					() => undefined,
					() => undefined,
				),
			]);
		} finally {
			await first.release();
		}

		expect((await second).id).toBe(made.id);
	});

	it("returns a member's oldest Personal Assistant once they have several", async () => {
		const member = { workspaceId, memberId: editorId };
		const oldest = await repository.ensurePersonalAssistant(member);
		await repository.addPersonalAssistant(member);

		expect((await repository.ensurePersonalAssistant(member)).id).toBe(oldest.id);
	});

	it("tells a member's Personal Assistants apart by the lowest number none of theirs has", async () => {
		const add = () => repository.addPersonalAssistant({ workspaceId, memberId: editorId });
		const first = await add();
		const second = await add();
		await repository.remove(workspaceId, first.id);
		const third = await add();
		const othersFirst = await repository.addPersonalAssistant({ workspaceId, memberId: adminId });

		expect(
			[first, second, third, othersFirst].map(({ name, handle }) => ({ name, handle })),
		).toEqual([
			{ name: "Personal Assistant", handle: "personal-assistant" },
			{ name: "Personal Assistant 2", handle: "personal-assistant-2" },
			{ name: "Personal Assistant", handle: "personal-assistant" },
			{ name: "Personal Assistant", handle: "personal-assistant" },
		]);
	});

	it("keeps an upgraded bot's handle addressable when making another Personal Assistant", async () => {
		const [existing] = await onDatabase((db) =>
			db
				.insert(bot)
				.values({
					workspaceId,
					name: "Guide",
					handle: "personal-assistant-2",
					color: "sky",
					eyes: "pill",
				})
				.returning({ id: bot.id }),
		);
		const member = await signedIn.member(editorId);
		await callOperation(member, "bots.createAssistant", { workspace: workspaceId });
		const added = await callOperation(member, "bots.createAssistant", { workspace: workspaceId });

		expect(added).toMatchObject({ name: "Personal Assistant 3", handle: "personal-assistant-3" });
		expect(
			(await visibleTo(editorId)).filter(({ handle }) => handle === "personal-assistant-2"),
		).toEqual([expect.objectContaining({ id: existing?.id, name: "Guide" })]);
	});

	it("does not individually delete a system bot", async () => {
		const system = await placeCompaction();
		await expect(repository.remove(workspaceId, system.id)).rejects.toBeInstanceOf(
			BotStore.SystemBotImmutable,
		);
	});

	it("does not change a system bot as a bot members talk to", async () => {
		const system = await placeCompaction();
		await expect(
			repository.update(workspaceId, system.id, { model: "another" }),
		).rejects.toBeInstanceOf(BotStore.SystemBotImmutable);
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
					eyes: "square",
					model: null,
				})
				.returning(),
		);
		if (!system) throw new Error("system bot setup failed");
		return system;
	}
});
