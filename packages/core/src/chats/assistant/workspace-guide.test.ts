import type { NewBot } from "@sugabots/contracts";
import type { InputOf } from "@sugabots/contracts/operations";
import { userText } from "@sugabots/errors";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedProjectChat } from "../../authentication/seed.test-support.ts";
import {
	automation,
	membership,
	message,
	modelProvider,
	project,
	projectMember,
	providerModel,
	readCursor,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../database/testing.ts";
import { createWorkspaceFixture } from "../../database/workspace.test-support.ts";
import { type CallOperation, servedOperations } from "../../operations/testing.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";
import { defaultProjectOf } from "../../workspaces/projects/project-reads.ts";
import { seedChat } from "../seed.test-support.ts";

/**
 * A Personal Assistant's view of its member's workspace, against real SQL: it
 * reads only what its member reaches, in its own turns' member bounds.
 */
describe.skipIf(!process.env.DATABASE_URL)("a Personal Assistant's workspace guide", () => {
	let callOperation: CallOperation;
	let signedIn: ReturnType<typeof principals>;

	let workspaceId: string;
	let workspaceSlug: string;
	let samId: string;
	let adaId: string;

	beforeAll(async () => {
		callOperation = await servedOperations();
		signedIn = principals(await authenticators());
	});

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const {
			workspace: made,
			members: { ada, samRow },
		} = await createWorkspaceFixture(
			{ name: `Guide ${stamp}`, slug: `guide-${stamp}` },
			{
				ada: { name: "Ada", email: `ada-${stamp}@example.com`, role: "editor" },
				samRow: { name: "Sam", email: `sam-${stamp}@example.com`, role: "editor" },
			},
		);
		workspaceId = made.id;
		workspaceSlug = made.slug;
		adaId = ada.id;
		samId = samRow.id;
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

	/** The bots operations these cases make bots with, called for `memberId` signed in. */
	const botsAs = (memberId: string) => ({
		create: async ({ workspace, bot }: { workspace: string; bot: NewBot }) =>
			callOperation(await signedIn.member(memberId), "bots.create", { workspace, ...bot }),
		createAssistant: async (input: InputOf<"bots.createAssistant">) =>
			callOperation(await signedIn.member(memberId), "bots.createAssistant", input),
	});

	/** The guide Sam's Personal Assistant reads in a chat of its own, for Sam. */
	const guideForSam = async () => {
		const assistant = await botsAs(samId).createAssistant({ workspace: workspaceId });
		const own = await runOnPostgres(defaultProjectOf(assistant.id));
		const chat = await seedProjectChat(workspaceId, own, samId);
		return callOperation(await signedIn.botFor(samId, assistant.id, chat), "workspaces.guide", {});
	};

	const aBot = (creatorId: string, name: string, visibility: "public" | "personal" = "public") =>
		botsAs(creatorId).create({
			workspace: workspaceId,
			bot: { name, model: "test-model", visibility },
		});

	it("shows the member the bots they reach, and nothing of others' personal ones", async () => {
		await aBot(adaId, "Writer");
		await aBot(adaId, "Diary", "personal");

		const seen = await guideForSam();

		expect(seen.bots).toEqual([
			expect.objectContaining({
				name: "Writer",
				handle: "@writer",
				link: `http://sugabots.test/${workspaceSlug}/bots/writer`,
			}),
		]);
		expect(seen.waitingOnYou).toEqual({
			approvals: [],
			unreadMentions: [],
			failingAutomations: [],
		});
	});

	it("suggests to an admin no other member's personal bot, which they can't talk to", async () => {
		await onDatabase((db) =>
			db
				.update(membership)
				.set({ role: "admin" })
				.where(and(eq(membership.workspaceId, workspaceId), eq(membership.memberId, samId))),
		);
		await aBot(adaId, "Writer");
		await aBot(adaId, "Diary", "personal");

		const seen = await guideForSam();

		expect(seen.bots.map(({ name }) => name)).toEqual(["Writer"]);
	});

	it("lists automations failing now, though the member has read their failed runs", async () => {
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
			db.insert(projectMember).values({ workspaceId, projectId: launch.id, memberId: samId }),
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
				seedChat(db, {
					workspaceId,
					kind: "automation_feed",
					automationId: defined.id,
					title: name,
				}),
			);
			const requestId = crypto.randomUUID();
			const finishedAt = new Date();
			const run = await onDatabase((db) =>
				seedChat(db, {
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
							requestedByMemberId: samId,
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
				db.insert(readCursor).values([
					{ chatId: feed.id, memberId: samId, readThrough },
					{ chatId: run.id, memberId: samId, readThrough },
				]),
			);
		};
		const own = await runOnPostgres(defaultProjectOf(writer.id));
		await anAutomation(own, "Failed last", "enabled", "failed");
		await anAutomation(own, "Gave up", "paused", "failed", true);
		await anAutomation(own, "Paused by hand", "paused", "failed");
		await anAutomation(own, "Fine", "enabled", "completed");
		await anAutomation(launch.id, "Launch report", "enabled", "failed");
		const assistant = await botsAs(samId).createAssistant({ workspace: workspaceId });
		const assistantProject = await runOnPostgres(defaultProjectOf(assistant.id));
		await anAutomation(assistantProject, "Morning brief", "enabled", "failed");
		// Sam isn't in the project, so its automations aren't theirs to hear about.
		await anAutomation(hidden.id, "Secret report", "enabled", "failed");

		const seen = await guideForSam();

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

	it("lists the member's unread mentions however many newer unread messages there are", async () => {
		const writer = await aBot(adaId, "Writer");
		const chat = await onDatabase((db) =>
			seedChat(db, {
				workspaceId,
				kind: "project_chat",
				botId: writer.id,
				title: "Launch",
				startedById: adaId,
			}),
		);
		const said = (content: string, createdAt: Date) => ({
			chatId: chat.id,
			authorMemberId: adaId,
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

		const seen = await guideForSam();

		expect(seen.waitingOnYou.unreadMentions).toEqual([
			expect.objectContaining({ from: "Ada", preview: "@sam can you look?" }),
		]);
	});

	it("is hidden from a bot outside member bounds", async () => {
		const writer = await aBot(adaId, "Writer");
		const chat = await seedProjectChat(
			workspaceId,
			await runOnPostgres(defaultProjectOf(writer.id)),
			samId,
		);

		await expect(
			callOperation(await signedIn.botFor(samId, writer.id, chat), "workspaces.guide", {}),
		).rejects.toMatchObject({ _tag: "ResourceHidden", resource: "workspace" });
	});
});
