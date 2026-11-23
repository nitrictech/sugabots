import { userText } from "@sugabots/errors";
import { and, eq } from "drizzle-orm";
import { Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { noComputers } from "../../computers/testing.ts";
import {
	automation,
	conversationRead,
	message,
	modelProvider,
	pinnedBot,
	project,
	projectBot,
	projectMember,
	providerModel,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	runOnPostgres,
	servedOnPostgres,
} from "../../database/testing.ts";
import { BotAdministration } from "../../workspaces/bots/bot-administration.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { servedOnPostgresAs } from "../../workspaces/testing.ts";
import { seedConversation } from "../seed.test-support.ts";
import { AssistantGuide } from "./assistant-guide.ts";

/**
 * A Personal Assistant's view of its person's workspace, and what it does
 * there for them, against real SQL: it reads and acts only as the person.
 */
describe.skipIf(!process.env.DATABASE_URL)("a Personal Assistant's guide", () => {
	let guide: Promised<AssistantGuide.Interface>;
	let botsAs: (userId: string) => Promised<BotAdministration.Interface>;

	let workspaceId: string;
	let workspaceSlug: string;
	let samId: string;
	let adaId: string;
	const sam = () => ({ userId: samId, workspaceId, workspaceSlug });

	beforeAll(async () => {
		guide = await servedOnPostgres(
			AssistantGuide.Service,
			AssistantGuide.layer.pipe(Layer.provide(noComputers)),
		);
		botsAs = await servedOnPostgresAs(
			BotAdministration.Service,
			BotAdministration.layer.pipe(Layer.provide(noComputers)),
		);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const [made] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: `Guide ${stamp}`, slug: `guide-${stamp}` })
				.returning(),
		);
		const [ada, samRow] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Ada", email: `ada-${stamp}@example.com` },
					{ name: "Sam", email: `sam-${stamp}@example.com` },
				])
				.returning(),
		);
		if (!made || !ada || !samRow) throw new Error("fixture");
		workspaceId = made.id;
		workspaceSlug = made.slug;
		adaId = ada.id;
		samId = samRow.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: adaId, role: "member" },
				{ workspaceId, userId: samId, role: "member" },
			]),
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
		if (!provider) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(providerModel).values({
				workspaceId,
				providerId: provider.id,
				modelId: "test-model",
				enabled: true,
				source: "manual",
			}),
		);
	});

	const aBot = (creatorId: string, name: string, visibility: "public" | "private" = "public") =>
		botsAs(creatorId).create({
			workspace: workspaceId,
			bot: { name, model: "test-model", visibility },
		});

	it("shows the person the bots they reach, and nothing of others' private ones", async () => {
		await aBot(adaId, "Writer");
		await aBot(adaId, "Diary", "private");

		const seen = await guide.guide(sam());

		expect(seen.bots).toEqual([
			expect.objectContaining({
				name: "Writer",
				handle: "@writer",
				link: `http://sugabots.test/${workspaceSlug}/bots/writer`,
				youCanTalkToIt: true,
			}),
		]);
		expect(seen.waitingOnYou).toEqual({
			approvals: [],
			unreadMentions: [],
			failingAutomations: [],
		});
	});

	it("lists automations failing now, though the person has read their failed runs", async () => {
		const writer = await aBot(adaId, "Writer");
		const [launch, hidden] = await onDatabase((db) =>
			db
				.insert(project)
				.values([
					{ workspaceId, name: "Launch", slug: "launch", leadBotId: writer.id },
					{
						workspaceId,
						name: "Secret",
						slug: "secret",
						leadBotId: writer.id,
						visibility: "private",
					},
				])
				.returning(),
		);
		if (!launch || !hidden) throw new Error("fixture");
		await onDatabase((db) =>
			db.insert(projectMember).values({ workspaceId, projectId: launch.id, userId: samId }),
		);
		const anAutomation = async (
			projectId: string,
			name: string,
			state: "enabled" | "paused",
			lastRun: "completed" | "failed",
			pausedAfterFailures = false,
		) => {
			const [defined] = await onDatabase((db) =>
				db
					.insert(automation)
					.values({
						workspaceId,
						projectId,
						name,
						instructions: "Report",
						state,
						pausedAfterFailuresAt: pausedAfterFailures ? new Date() : null,
					})
					.returning(),
			);
			if (!defined) throw new Error("fixture");
			const feed = await onDatabase((db) =>
				seedConversation(db, {
					workspaceId,
					kind: "automation_feed",
					automationId: defined.id,
					title: name,
				}),
			);
			const requestId = crypto.randomUUID();
			const finishedAt = new Date();
			const run = await onDatabase((db) =>
				seedConversation(db, {
					workspaceId,
					kind: "run",
					title: name,
					run: {
						automationId: defined.id,
						botId: writer.id,
						triggerKind: "manual",
						triggerIdentity: requestId,
						trigger: {
							kind: "manual",
							requestId,
							requestedAt: finishedAt.toISOString(),
							requestedByUserId: samId,
						},
						automationName: name,
						instructions: "Report",
						state: lastRun,
						error: lastRun === "failed" ? userText`It broke` : undefined,
						startedAt: finishedAt,
						finishedAt,
					},
				}),
			);
			// Sam has read every run, and the feed they are posted to.
			const readThrough = new Date(Date.now() + 1000);
			await onDatabase((db) =>
				db.insert(conversationRead).values([
					{ conversationId: feed.id, userId: samId, readThrough },
					{ conversationId: run.id, userId: samId, readThrough },
				]),
			);
		};
		const own = await runOnPostgres(defaultProjectOf(writer.id));
		await anAutomation(own, "Failed last", "enabled", "failed");
		await anAutomation(own, "Gave up", "paused", "failed", true);
		await anAutomation(own, "Paused by hand", "paused", "failed");
		await anAutomation(own, "Fine", "enabled", "completed");
		await anAutomation(launch.id, "Launch report", "enabled", "failed");
		const assistant = await botsAs(samId).ensureAssistant({ workspace: workspaceId });
		const assistantProject = await runOnPostgres(defaultProjectOf(assistant.id));
		await anAutomation(assistantProject, "Morning brief", "enabled", "failed");
		// Sam isn't in the project, so its automations aren't theirs to hear about.
		await anAutomation(hidden.id, "Secret report", "enabled", "failed");

		const seen = await guide.guide(sam());

		expect(seen.waitingOnYou.failingAutomations).toEqual(
			expect.arrayContaining([
				{
					bot: "Writer",
					failing: 2,
					link: `http://sugabots.test/${workspaceSlug}/bots/writer/automations`,
				},
				{
					project: "Launch",
					failing: 1,
					link: `http://sugabots.test/${workspaceSlug}/projects/launch/automations`,
				},
				{
					bot: assistant.name,
					failing: 1,
					link: `http://sugabots.test/${workspaceSlug}/bots/${assistant.handle}/automations`,
				},
			]),
		);
		expect(seen.waitingOnYou.failingAutomations).toHaveLength(3);
	});

	it("makes a project for the person, led by a public bot, adds another to it, and refuses a private one", async () => {
		const writer = await aBot(samId, "Writer");
		const editor = await aBot(samId, "Editor");
		await aBot(samId, "Diary", "private");

		await expect(
			guide.createProject(sam(), { name: "Launch", lead: "@diary" }),
		).rejects.toMatchObject({ _tag: "BotNotPublic" });
		const made = await guide.createProject(sam(), {
			name: "Launch",
			lead: "@writer",
			description: "Q4 launch",
		});
		expect(made).toEqual({
			name: "Launch",
			link: `http://sugabots.test/${workspaceSlug}/projects/launch`,
		});
		await guide.addBotToProject(sam(), { project: "#launch", bot: "@editor" });
		const placed = await onDatabase((db) =>
			db
				.select({ botId: projectBot.botId })
				.from(projectBot)
				.innerJoin(project, eq(project.id, projectBot.projectId))
				.where(and(eq(project.workspaceId, workspaceId), eq(project.slug, "launch"))),
		);
		expect(placed.map(({ botId }) => botId).sort()).toEqual([writer.id, editor.id].sort());
		expect((await guide.guide(sam())).projects).toEqual([
			expect.objectContaining({ address: "launch", lead: "@writer" }),
		]);

		await expect(
			guide.addBotToProject(sam(), { project: "launch", bot: "diary" }),
		).rejects.toMatchObject({ _tag: "BotNotPublic" });
		await expect(
			guide.addBotToProject(sam(), { project: "nowhere", bot: "writer" }),
		).rejects.toMatchObject({ _tag: "NothingNamed" });
	});

	it("lists the person's unread mentions however many newer unread messages there are", async () => {
		const writer = await aBot(adaId, "Writer");
		const thread = await onDatabase((db) =>
			seedConversation(db, {
				workspaceId,
				kind: "project_thread",
				botId: writer.id,
				title: "Launch",
				startedById: adaId,
			}),
		);
		const said = (content: string, createdAt: Date) => ({
			conversationId: thread.id,
			authorUserId: adaId,
			kind: "text" as const,
			status: "complete" as const,
			parts: [{ type: "text" as const, text: content }],
			content,
			createdAt,
		});
		const start = Date.now() - 60 * 60 * 1000;
		await onDatabase((db) =>
			db
				.insert(message)
				.values([
					said("@sam can you look?", new Date(start)),
					...Array.from({ length: 60 }, (_, index) =>
						said(`Update ${index}`, new Date(start + (index + 1) * 1000)),
					),
				]),
		);

		const seen = await guide.guide(sam());

		expect(seen.waitingOnYou.unreadMentions).toEqual([
			expect.objectContaining({ from: "Ada", preview: "@sam can you look?" }),
		]);
	});

	it("does for a viewer only what the viewer may do themselves", async () => {
		await onDatabase((db) =>
			db.update(workspaceMember).set({ role: "viewer" }).where(eq(workspaceMember.userId, samId)),
		);

		await aBot(adaId, "Writer");

		await expect(
			guide.createProject(sam(), { name: "Launch", lead: "@writer" }),
		).rejects.toMatchObject({
			_tag: "ActionForbidden",
		});
	});

	it("acts only on the project at exactly the address given, not one by that name", async () => {
		await aBot(samId, "Writer");
		await guide.createProject(sam(), { name: "Launch", lead: "@writer" });

		await expect(
			guide.addBotToProject(sam(), { project: "Launch", bot: "@writer" }),
		).rejects.toMatchObject({ _tag: "NothingNamed" });
		await expect(
			guide.addBotToProject(sam(), { project: "launch", bot: "@Writer" }),
		).rejects.toMatchObject({ _tag: "NothingNamed" });
	});

	it("pins and unpins a bot for the person only", async () => {
		const writer = await aBot(adaId, "Writer");

		await guide.pinBot(sam(), { bot: "writer", pinned: true });
		const pinsOf = () =>
			onDatabase((db) =>
				db
					.select({ userId: pinnedBot.userId })
					.from(pinnedBot)
					.where(eq(pinnedBot.botId, writer.id)),
			);
		expect((await pinsOf()).map(({ userId }) => userId).sort()).toEqual([adaId, samId].sort());

		await guide.pinBot(sam(), { bot: "writer", pinned: false });
		expect(await pinsOf()).toEqual([{ userId: adaId }]);
	});
});
