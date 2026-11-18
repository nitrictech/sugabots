import { userText } from "@sugabots/errors";
import { eq } from "drizzle-orm";
import { Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	agentSummary,
	modelProvider,
	pinnedAgent,
	podAgent,
	providerModel,
	routine,
	routineExecution,
	thread,
	threadRead,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	type Promised,
	servedOnPostgres,
} from "../../database/testing.ts";
import { noComputers } from "../../sandboxes/testing.ts";
import { AgentAdministration } from "../../workspaces/agents/agent-administration.ts";
import { servedOnPostgresAs } from "../../workspaces/testing.ts";
import { AssistantGuide } from "./assistant-guide.ts";

/**
 * A Personal Assistant's view of its person's workspace, and what it does
 * there for them, against real SQL: it reads and acts only as the person.
 */
describe.skipIf(!process.env.DATABASE_URL)("a Personal Assistant's guide", () => {
	let guide: Promised<AssistantGuide.Interface>;
	let agentsAs: (userId: string) => Promised<AgentAdministration.Interface>;

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
		agentsAs = await servedOnPostgresAs(
			AgentAdministration.Service,
			AgentAdministration.layer.pipe(Layer.provide(noComputers)),
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
		agentsAs(creatorId).create({
			workspace: workspaceId,
			agent: { name, model: "test-model", visibility },
		});

	it("shows the person the bots they reach, with what each has been doing, and nothing of others' private ones", async () => {
		const writer = await aBot(adaId, "Writer");
		const diary = await aBot(adaId, "Diary", "private");
		await onDatabase((db) =>
			db.insert(agentSummary).values([
				{ agentId: writer.id, content: "Drafting the launch post.", coversThrough: new Date() },
				{ agentId: diary.id, content: "Ada's private notes.", coversThrough: new Date() },
			]),
		);

		const seen = await guide.guide(sam());

		expect(seen.bots).toEqual([
			expect.objectContaining({
				name: "Writer",
				handle: "@writer",
				link: `http://sugabots.test/${workspaceSlug}/bots/writer`,
				youCanTalkToIt: true,
				lately: "Drafting the launch post.",
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
		const automation = async (
			name: string,
			state: "enabled" | "paused",
			lastRun: "completed" | "failed",
			pausedAfterFailures = false,
		) => {
			const [defined] = await onDatabase((db) =>
				db
					.insert(routine)
					.values({
						workspaceId,
						agentId: writer.id,
						name,
						instructions: "Report",
						state,
						pausedAfterFailuresAt: pausedAfterFailures ? new Date() : null,
					})
					.returning(),
			);
			if (!defined) throw new Error("fixture");
			const feedId = crypto.randomUUID();
			await onDatabase((db) =>
				db.insert(thread).values({
					id: feedId,
					workspaceId,
					hostAgentId: writer.id,
					conversationId: feedId,
					routineId: defined.id,
					type: "routine_feed",
					title: name,
				}),
			);
			const requestId = crypto.randomUUID();
			const finishedAt = new Date();
			await onDatabase((db) =>
				db.insert(routineExecution).values({
					routineId: defined.id,
					workspaceId,
					agentId: writer.id,
					threadId: feedId,
					triggerKind: "manual",
					triggerIdentity: requestId,
					trigger: {
						kind: "manual",
						requestId,
						requestedAt: finishedAt.toISOString(),
						requestedByUserId: samId,
					},
					routineName: name,
					instructions: "Report",
					state: lastRun,
					error: lastRun === "failed" ? userText`It broke` : undefined,
					startedAt: finishedAt,
					finishedAt,
				}),
			);
			// Sam has read every run.
			await onDatabase((db) =>
				db
					.insert(threadRead)
					.values({ threadId: feedId, userId: samId, readThrough: new Date(Date.now() + 1000) }),
			);
		};
		await automation("Failed last", "enabled", "failed");
		await automation("Gave up", "paused", "failed", true);
		await automation("Paused by hand", "paused", "failed");
		await automation("Fine", "enabled", "completed");

		const seen = await guide.guide(sam());

		expect(seen.waitingOnYou.failingAutomations).toEqual([
			{
				bot: "Writer",
				failing: 2,
				link: `http://sugabots.test/${workspaceSlug}/bots/writer/automations`,
			},
		]);
	});

	it("makes a channel for the person, adds a public bot to it, and refuses a private one", async () => {
		const writer = await aBot(samId, "Writer");
		await aBot(samId, "Diary", "private");

		const channel = await guide.createChannel(sam(), { name: "Launch", description: "Q4 launch" });
		expect(channel).toEqual({
			name: "Launch",
			link: `http://sugabots.test/${workspaceSlug}/channels/launch`,
		});
		await guide.addBotToChannel(sam(), { channel: "#launch", bot: "@writer" });
		const placed = await onDatabase((db) =>
			db
				.select({ agentId: podAgent.agentId })
				.from(podAgent)
				.where(eq(podAgent.agentId, writer.id)),
		);
		expect(placed).toHaveLength(1);

		await expect(
			guide.addBotToChannel(sam(), { channel: "launch", bot: "diary" }),
		).rejects.toMatchObject({ _tag: "BotNotPublic" });
		await expect(
			guide.addBotToChannel(sam(), { channel: "nowhere", bot: "writer" }),
		).rejects.toMatchObject({ _tag: "NothingNamed" });
	});

	it("pins and unpins a bot for the person only", async () => {
		const writer = await aBot(adaId, "Writer");

		await guide.pinBot(sam(), { bot: "writer", pinned: true });
		const pinsOf = () =>
			onDatabase((db) =>
				db
					.select({ userId: pinnedAgent.userId })
					.from(pinnedAgent)
					.where(eq(pinnedAgent.agentId, writer.id)),
			);
		expect((await pinsOf()).map(({ userId }) => userId).sort()).toEqual([adaId, samId].sort());

		await guide.pinBot(sam(), { bot: "writer", pinned: false });
		expect(await pinsOf()).toEqual([{ userId: adaId }]);
	});
});
