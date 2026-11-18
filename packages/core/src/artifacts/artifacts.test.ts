import { MAX_ARTIFACT_CONTENT_CHARACTERS } from "@sugabots/contracts";
import { eq, like } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Credentials } from "../credentials/credentials.ts";
import {
	agent,
	artifactVersion,
	blobDeletion,
	pod,
	podAgent,
	podMember,
	thread,
	user,
	workspace,
	workspaceMember,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { Installation } from "../installation/installation.ts";
import { servedOnPostgresAs } from "../workspaces/testing.ts";
import { Artifacts } from "./artifacts.ts";
import { ArtifactPages } from "./pages.ts";

/** Seals as the test infrastructure's credentials do, to forge tokens in a case. */
const testCredentials = Credentials.fromKey(Buffer.alloc(32).toString("base64"));

describe.skipIf(!process.env.DATABASE_URL)("artifacts, against Postgres", () => {
	let by: Artifacts.AgentInThread;
	let memberId: string;
	let outsiderId: string;
	let adminId: string;
	let podId: string;
	/** A bot outside the channel, working in a task of its own. */
	let botElsewhere: Artifacts.AgentInThread;
	/** The channel's bot, asked by the bot outside it from that bot's task. */
	let writerAskedFromTask: Artifacts.AgentInThread;
	/** The bot outside the channel, asked from the channel's main chat. */
	let strangerAskedFromChannel: Artifacts.AgentInThread;

	const authoring = async () => ({
		service: await runOnPostgres(Effect.provide(Artifacts.Authoring, Artifacts.authoringLayer)),
		/** Runs `effect`, which should fail, to its failure. */
		failureOf: <A, E>(effect: Effect.Effect<A, E>) => runOnPostgres(Effect.flip(effect)),
	});

	it("writes over a version in place, keeping its number and queueing its old content", async () => {
		const { service } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "document", title: "Notes", content: "# One" }),
		);

		const over = await runOnPostgres(
			service.edit(by, {
				artifactId: made.id,
				baseVersion: 1,
				oldText: "One",
				newText: "Two",
				inPlace: true,
			}),
		);

		expect(over).toMatchObject({ version: 1, content: "# Two" });
		expect(await runOnPostgres(service.read(by, made.id))).toMatchObject({
			version: 1,
			content: "# Two",
		});
		const queued = await onDatabase((db) =>
			db
				.select()
				.from(blobDeletion)
				.where(like(blobDeletion.prefix, `artifacts/${made.id}/%`)),
		);
		expect(queued).toHaveLength(1);
	});

	it("keeps both of two in-place edits made at once", async () => {
		const { service } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "document", title: "Notes", content: "# One\n\nTwo" }),
		);
		const inPlaceEdit = (oldText: string, newText: string) =>
			service.edit(by, { artifactId: made.id, baseVersion: 1, oldText, newText, inPlace: true });

		await runOnPostgres(
			Effect.all([inPlaceEdit("One", "Uno"), inPlaceEdit("Two", "Dos")], { concurrency: 2 }),
		);

		expect(await runOnPostgres(service.read(by, made.id))).toMatchObject({
			version: 1,
			content: "# Uno\n\nDos",
		});
	});

	describe("pages on the content origin", () => {
		const pagesAt = (contentOrigin: string | undefined) =>
			servedOnPostgresAs(
				ArtifactPages.Service,
				ArtifactPages.layer.pipe(
					Layer.provide(
						Layer.succeed(
							Installation.Service,
							Installation.fromUrls({
								isProduction: false,
								publicUrl: "https://sugabots.example.com",
								...(contentOrigin ? { contentOrigin } : {}),
							}),
						),
					),
				),
			);
		const aPage = async () => {
			const { service } = await authoring();
			return runOnPostgres(
				service.create(by, { kind: "html", title: "Chart", content: "<p>chart</p>" }),
			);
		};

		it("gives the channel's people an address on the content origin that opens the page", async () => {
			const made = await aPage();
			const pages = (await pagesAt("https://pages.example-content.com"))(memberId);

			const address = await pages.address({ artifactId: made.id, version: 1 });

			expect(address).toMatch(/^https:\/\/pages\.example-content\.com\/pages\/.+/);
			const token = address?.split("/pages/")[1] ?? "";
			expect(await pages.open(token)).toEqual({ title: "Chart", html: "<p>chart</p>" });
		});

		it("gives no address without a content origin, nor for a document", async () => {
			const made = await aPage();
			const { service } = await authoring();
			const notes = await runOnPostgres(
				service.create(by, { kind: "document", title: "Notes", content: "# Notes" }),
			);

			const unset = (await pagesAt(undefined))(memberId);
			const set = (await pagesAt("https://pages.example-content.com"))(memberId);

			expect(await unset.address({ artifactId: made.id, version: 1 })).toBeUndefined();
			expect(await set.address({ artifactId: notes.id, version: 1 })).toBeUndefined();
		});

		it("gives no address for a version the page doesn't have", async () => {
			const made = await aPage();
			const pages = (await pagesAt("https://pages.example-content.com"))(memberId);

			await expect(pages.address({ artifactId: made.id, version: 2 })).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});
		});

		it("hides a page from people outside its channel", async () => {
			const made = await aPage();
			const pages = (await pagesAt("https://pages.example-content.com"))(outsiderId);

			await expect(pages.address({ artifactId: made.id, version: 1 })).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});
		});

		it("refuses a tampered or expired token, and a value sealed for something else", async () => {
			const made = await aPage();
			const pages = (await pagesAt("https://pages.example-content.com"))(memberId);
			const sealed = (expiresAt: number, purpose?: string) =>
				testCredentials.encrypt(
					JSON.stringify({ artifactId: made.id, version: 1, expiresAt }),
					purpose,
				);

			const good = sealed(Date.now() + 60_000, ArtifactPages.SEALED_FOR);
			const flipped = `${good.slice(0, -4)}${good.at(-4) === "A" ? "B" : "A"}${good.slice(-3)}`;
			await expect(pages.open(flipped)).rejects.toMatchObject({
				_tag: "ArtifactPageUnavailable",
			});
			await expect(
				pages.open(sealed(Date.now() - 1, ArtifactPages.SEALED_FOR)),
			).rejects.toMatchObject({
				_tag: "ArtifactPageUnavailable",
			});
			await expect(pages.open(sealed(Date.now() + 60_000))).rejects.toMatchObject({
				_tag: "ArtifactPageUnavailable",
			});
			expect(await pages.open(good)).toMatchObject({ title: "Chart" });
		});
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Artifacts ${stamp}`, slug: `artifacts-${stamp}` })
				.returning(),
		);
		const [member, outsider, admin] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Kim", email: `kim-${stamp}@example.com` },
					{ name: "Ola", email: `ola-${stamp}@example.com` },
					{ name: "Ada", email: `ada-${stamp}@example.com` },
				])
				.returning(),
		);
		if (!space || !member || !outsider || !admin) throw new Error("fixture");
		const workspaceId = space.id;
		memberId = member.id;
		outsiderId = outsider.id;
		adminId = admin.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: memberId, role: "member" },
				{ workspaceId, userId: outsiderId, role: "member" },
				{ workspaceId, userId: adminId, role: "admin" },
			]),
		);
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({ workspaceId, name: "Planning", slug: `planning-${stamp}` })
				.returning(),
		);
		if (!room) throw new Error("fixture");
		podId = room.id;
		await onDatabase((db) => db.insert(podMember).values({ workspaceId, podId, userId: memberId }));
		const [writer, stranger] = await onDatabase((db) =>
			db
				.insert(agent)
				.values(
					["Scribe", "Stranger"].map((name) => ({
						workspaceId,
						name,
						handle: `${name.toLowerCase()}-${stamp}`,
						color: "green" as const,
						face: "pill" as const,
						model: "claude-opus-4-1-20250805",
						createdById: memberId,
					})),
				)
				.returning(),
		);
		if (!writer || !stranger) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(podAgent).values({ workspaceId, podId, agentId: writer.id }),
		);
		const [mainChat, strangersTask] = await onDatabase((db) =>
			db
				.insert(thread)
				.values([
					{ workspaceId, podId, type: "pod_chat", main: true, title: "Planning" },
					{ workspaceId, hostAgentId: stranger.id, type: "conversation", title: "Elsewhere" },
				])
				.returning(),
		);
		if (!mainChat || !strangersTask) throw new Error("fixture");
		by = { workspaceId, agentId: writer.id, threadId: mainChat.id };
		botElsewhere = { workspaceId, agentId: stranger.id, threadId: strangersTask.id };
		// The channel's bot asked from the other bot's task, and the other bot from the channel.
		const [askedFromTask, askedFromChannel] = await onDatabase((db) =>
			db
				.insert(thread)
				.values([
					{
						workspaceId,
						hostAgentId: writer.id,
						conversationId: strangersTask.id,
						parentThreadId: strangersTask.id,
						type: "collaboration",
						title: "Asked from the task",
					},
					{
						workspaceId,
						hostAgentId: stranger.id,
						conversationId: mainChat.id,
						parentThreadId: mainChat.id,
						type: "collaboration",
						title: "Asked from the channel",
					},
				])
				.returning(),
		);
		if (!askedFromTask || !askedFromChannel) throw new Error("fixture");
		writerAskedFromTask = { workspaceId, agentId: writer.id, threadId: askedFromTask.id };
		strangerAskedFromChannel = { workspaceId, agentId: stranger.id, threadId: askedFromChannel.id };
	});

	it("keeps every version of a document a bot writes, for people in its channel to read", async () => {
		const { service } = await authoring();
		const made = await runOnPostgres(
			service.create(by, {
				kind: "document",
				title: "Launch plan",
				content: "# Launch plan\n\n## Goals\n\nShip.\n\n## Risks\n\nNone yet.\n",
			}),
		);
		await runOnPostgres(
			service.edit(by, {
				artifactId: made.id,
				baseVersion: 1,
				oldText: "Ship.",
				newText: "Ship by Friday.",
			}),
		);

		const reader = (await servedOnPostgresAs(Artifacts.Service, Artifacts.layer))(memberId);
		const at = { artifactId: made.id };
		expect(await reader.get(at)).toMatchObject({
			version: 2,
			createdBy: { name: "Scribe" },
			content: "# Launch plan\n\n## Goals\n\nShip by Friday.\n\n## Risks\n\nNone yet.\n",
		});
		expect((await reader.versions(at)).map((version) => version.number)).toEqual([2, 1]);
		expect(await reader.getVersion({ ...at, version: 1 })).toMatchObject({
			version: 2,
			shownVersion: { number: 1 },
			content: expect.stringContaining("Ship.\n"),
		});
	});

	it("refuses a change based on an older version, and keeps the newer one", async () => {
		const { service, failureOf } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "html", title: "Chart", content: "<p>one</p>" }),
		);
		await runOnPostgres(
			service.replace(by, { artifactId: made.id, baseVersion: 1, content: "<p>two</p>" }),
		);

		const stale = await failureOf(
			service.replace(by, { artifactId: made.id, baseVersion: 1, content: "<p>lost</p>" }),
		);

		expect(stale).toMatchObject({ _tag: "ArtifactStale", currentVersion: 2 });
		expect(
			await failureOf(
				service.replace(by, {
					artifactId: made.id,
					baseVersion: 2,
					content: "# Doc",
					kind: "document",
				}),
			),
		).toMatchObject({ _tag: "ArtifactKindFixed", kind: "html" });
		expect(await runOnPostgres(service.read(by, made.id))).toMatchObject({
			version: 2,
			content: "<p>two</p>",
		});
	});

	it("refuses an edit whose text isn't in the artifact exactly once", async () => {
		const { service, failureOf } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "html", title: "Tiles", content: "<b>a</b><b>a</b>" }),
		);

		const edit = (oldText: string) =>
			failureOf(service.edit(by, { artifactId: made.id, baseVersion: 1, oldText, newText: "b" }));

		expect(await edit("<b>a</b>")).toMatchObject({ _tag: "EditTextUnmatched", matches: 2 });
		expect(await edit("<i>")).toMatchObject({ _tag: "EditTextUnmatched", matches: 0 });
		expect(await runOnPostgres(service.read(by, made.id))).toMatchObject({ version: 1 });
	});

	it("refuses an edit that would take an artifact over its size limit", async () => {
		const { service, failureOf } = await authoring();
		const made = await runOnPostgres(
			service.create(by, {
				kind: "document",
				title: "Long",
				content: `${"x".repeat(MAX_ARTIFACT_CONTENT_CHARACTERS - 1)}!`,
			}),
		);

		expect(
			await failureOf(
				service.edit(by, { artifactId: made.id, baseVersion: 1, oldText: "!", newText: "!!" }),
			),
		).toMatchObject({ _tag: "ArtifactTooLarge", maxCharacters: MAX_ARTIFACT_CONTENT_CHARACTERS });
	});

	it("hides a channel's files from people outside it and from bots outside it", async () => {
		const { service, failureOf } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "document", title: "Private", content: "# Private" }),
		);

		const outsider = (await servedOnPostgresAs(Artifacts.Service, Artifacts.layer))(outsiderId);
		await expect(outsider.get({ artifactId: made.id })).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
		expect(await failureOf(service.read(botElsewhere, made.id))).toMatchObject({
			_tag: "ArtifactNotFound",
		});
	});

	it("lets an admin delete a channel's file with its versions, and refuses its members", async () => {
		const { service } = await authoring();
		const made = await runOnPostgres(
			service.create(by, { kind: "document", title: "Draft", content: "# One" }),
		);
		await runOnPostgres(
			service.replace(by, { artifactId: made.id, baseVersion: 1, content: "# Two" }),
		);
		const as = await servedOnPostgresAs(Artifacts.Service, Artifacts.layer);
		const at = { artifactId: made.id };

		await expect(as(memberId).remove(at)).rejects.toMatchObject({ _tag: "ActionForbidden" });
		await as(adminId).remove(at);

		await expect(as(memberId).get(at)).rejects.toMatchObject({ _tag: "ResourceHidden" });
		expect(await as(memberId).listInPod({ podId })).toEqual([]);
		const versionsLeft = await onDatabase((db) =>
			db.select().from(artifactVersion).where(eq(artifactVersion.artifactId, made.id)),
		);
		expect(versionsLeft).toEqual([]);
	});

	it("shows the files a bot made in its tasks to whoever reaches the bot, and to nobody else", async () => {
		const { service } = await authoring();
		await onDatabase((db) =>
			db.update(agent).set({ visibility: "private" }).where(eq(agent.id, botElsewhere.agentId)),
		);
		const made = await runOnPostgres(
			service.create(botElsewhere, { kind: "document", title: "Diary", content: "# Diary" }),
		);
		const as = await servedOnPostgresAs(Artifacts.Service, Artifacts.layer);

		expect(await as(memberId).get({ artifactId: made.id })).toMatchObject({ title: "Diary" });
		expect(
			(await as(memberId).listForAgent({ agentId: botElsewhere.agentId })).map(({ id }) => id),
		).toEqual([made.id]);
		for (const somebodyElse of [outsiderId, adminId]) {
			await expect(as(somebodyElse).get({ artifactId: made.id })).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});
		}
		await expect(as(memberId).listInPod({ podId })).resolves.toEqual([]);
	});

	it("keeps a bot's files with the conversation it made them in, wherever else it works", async () => {
		const { service, failureOf } = await authoring();
		const inChannel = await runOnPostgres(
			service.create(by, { kind: "document", title: "Channel plan", content: "# Plan" }),
		);
		const forTheTask = await runOnPostgres(
			service.create(writerAskedFromTask, { kind: "document", title: "Answer", content: "# A" }),
		);
		const forTheChannel = await runOnPostgres(
			service.create(strangerAskedFromChannel, { kind: "document", title: "Help", content: "# H" }),
		);
		const ids = (summaries: { id: string }[]) => summaries.map(({ id }) => id).sort();

		// Asked from another bot's task, the channel's bot can't bring the channel's files.
		expect(await failureOf(service.read(writerAskedFromTask, inChannel.id))).toMatchObject({
			_tag: "ArtifactNotFound",
		});
		expect(ids(await runOnPostgres(service.list(writerAskedFromTask)))).toEqual([forTheTask.id]);
		// What it made there belongs to the task that asked, and the channel sees what it asked for.
		expect(ids(await runOnPostgres(service.list(botElsewhere)))).toEqual([forTheTask.id]);
		expect(ids(await runOnPostgres(service.list(by)))).toEqual(
			[inChannel.id, forTheChannel.id].sort(),
		);

		const as = await servedOnPostgresAs(Artifacts.Service, Artifacts.layer);
		expect(ids(await as(memberId).listInPod({ podId }))).toEqual(
			[inChannel.id, forTheChannel.id].sort(),
		);
		expect(ids(await as(memberId).listForAgent({ agentId: by.agentId }))).toEqual([]);
		expect(ids(await as(memberId).listForAgent({ agentId: botElsewhere.agentId }))).toEqual([
			forTheTask.id,
		]);
	});
});
