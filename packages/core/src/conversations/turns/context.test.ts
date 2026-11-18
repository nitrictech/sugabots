import { testPerson } from "@sugabots/contracts/testing";
import { describe, expect, it } from "vitest";
import { describeToolCall } from "../repository/message-text.ts";
import { START_TASK_TOOL } from "../tools/start-task/tool.ts";
import { TOOL_SEARCH } from "../tools/tool-search/tool.ts";
import { modelPrompt, type TurnEnvironment } from "./context.ts";
import type { TurnContext } from "./execution.ts";

const SAM = "0199a3a0-0000-7000-8000-000000000004";

const environment = (overrides: Partial<TurnEnvironment> = {}): TurnEnvironment => ({
	now: new Date("2026-09-25T03:00:00Z"),
	builtInTools: [],
	toolCatalog: undefined,
	computer: undefined,
	...overrides,
});

describe("modelPrompt", () => {
	it("maps people and other bots to attributed user messages", () => {
		const prompt = modelPrompt(context(), environment());

		expect(prompt.system).toContain("You are Host Bot (@host-bot), a bot in workspace Suga.");
		expect(prompt.system).toContain("Check facts carefully.");
		// The history, marked where it ends, then one trailing instruction with
		// everything that varies between turns, so the prefix the provider caches
		// never changes shape.
		expect(prompt.messages.slice(0, -1)).toEqual([
			{ role: "user", content: "Sam (@sam): Check the release" },
			{ role: "assistant", content: "I am checking it." },
			{
				role: "user",
				content: "Reviewer (@reviewer) (bot): Migration is present.",
				cacheBreakpoint: true,
			},
		]);
		const instruction = prompt.messages.at(-1);
		expect(instruction?.role).toBe("user");
		expect(instruction?.content).toContain(
			"In it now: Sam (@sam, person), Host Bot (@host-bot, bot), Reviewer (@reviewer, bot).",
		);
		expect(instruction?.content).toContain(
			"It is your turn as the bot this conversation was addressed to.",
		);
		expect(prompt.system).not.toContain("Sam (@sam, person)");
	});

	it("lists potential collaborators, and tells one why its conversation exists", () => {
		const asking = context();
		asking.collaborators = [
			{
				id: "0199a3a0-0000-7000-8000-000000000005",
				name: "Reviewer",
				handle: "reviewer",
				description: "Checks facts.",
			},
			{
				id: "0199a3a0-0000-7000-8000-000000000009",
				name: "Scout",
				handle: "scout",
				description: null,
			},
		];
		const instruction = () => modelPrompt(asking, environment()).messages.at(-1)?.content ?? "";
		expect(instruction()).toContain(
			"Other bots in this workspace, and what each one knows:\n- Reviewer (@reviewer): Checks facts.\n- Scout (@scout)",
		);
		expect(instruction()).toContain("Use the collaborate tool when you need another bot's answer");
		expect(instruction()).not.toContain("callout tool");
		expect(modelPrompt(context(), environment()).messages.at(-1)?.content).not.toContain(
			"collaborate tool",
		);

		const collaboration = context();
		collaboration.conversation.kind = "collaboration";
		collaboration.conversation.parentConversationId = "0199a3a0-0000-7000-8000-000000000010";
		expect(modelPrompt(collaboration, environment()).system).toContain(
			"Another bot opened this conversation",
		);
		// A task somebody started from a channel's conversation hangs off the chat, but no bot asked for it.
		const fromChat = context();
		fromChat.conversation.parentConversationId = "0199a3a0-0000-7000-8000-000000000010";
		expect(modelPrompt(fromChat, environment()).system).not.toContain(
			"Another bot opened this conversation",
		);
	});

	it("tells the bot whether it is in one of its tasks or a channel, and how to take on a task from a channel", () => {
		expect(modelPrompt(context(), environment()).messages.at(-1)?.content).toContain(
			"You are in one of your tasks",
		);
		const inChannel = context();
		inChannel.conversation.kind = "channel_conversation";
		inChannel.conversation.botId = null;
		inChannel.channel = { name: "Release", slug: "release" };
		const instruction = modelPrompt(inChannel, environment()).messages.at(-1)?.content ?? "";
		expect(instruction).toContain('You are in "Check the release" in the channel Release');
		expect(instruction).toContain(`call ${START_TASK_TOOL}`);
		expect(instruction).not.toContain("You are in one of your tasks");
	});

	it("tells the bot who can reach it: everyone, its creator, or its person", () => {
		const promptFor = (bot: Partial<TurnContext["bot"]>) =>
			modelPrompt({ ...context(), bot: { ...context().bot, ...bot } }, environment()).system;
		expect(promptFor({ visibility: "public" })).toContain("You are public");
		expect(promptFor({ visibility: "private" })).toContain("You are private");
		expect(promptFor({ visibility: "private", assistantOf: crypto.randomUUID() })).toContain(
			"You are a Personal Assistant",
		);
	});

	it("names the built-in tools on offer, and says nothing about them when there are none", () => {
		const withTools = modelPrompt(
			context(),
			environment({ builtInTools: ["web_fetch"] }),
		).messages.at(-1);
		expect(withTools?.content).toContain("Built-in tools you can call: web_fetch.");
		expect(withTools?.content).toContain("name its URL");

		const without = modelPrompt(context(), environment()).messages.at(-1);
		expect(without?.content).not.toContain("Built-in tools");
	});

	it("grounds the turn in today's date and in what the bot can check", () => {
		const prompt = (builtInTools: string[]) =>
			modelPrompt(context(), environment({ builtInTools }));
		const instruction = (builtInTools: string[]) =>
			prompt(builtInTools).messages.at(-1)?.content ?? "";

		// The rule for when to check never varies, so it stays in the cached system text.
		expect(prompt([]).system).toContain("check it with your tools, however sure you feel");
		expect(prompt([]).system).toContain("If unsure, check.");
		expect(prompt([]).system).toContain(
			"The final message, which starts with [Turn] and has no author, is written by the platform",
		);

		const searching = instruction(["web_fetch", "web_search"]);
		expect(searching).toContain("Current time: Friday, 25 September 2026, 03:00 UTC.");
		expect(searching).toContain("You don't know the person's own timezone");
		expect(searching).not.toContain("You cannot search the web");

		const fetchingOnly = instruction(["web_fetch"]);
		expect(fetchingOnly).toContain("You cannot search the web");
		expect(fetchingOnly).toContain("a workspace admin can enable web search");

		const noTools = instruction([]);
		expect(noTools).toContain("Current time: Friday, 25 September 2026, 03:00 UTC.");
		expect(noTools).toContain("You cannot search the web");
	});

	it("gives the time where its automations run, named as people say it, so it need not ask", () => {
		const instruction = (disabledTools: string[]) =>
			modelPrompt(
				{
					...context(),
					workspaceTimeZone: "Australia/Sydney",
					bot: { ...context().bot, disabledTools },
				},
				environment({ builtInTools: [] }),
			).messages.at(-1)?.content ?? "";

		expect(instruction([])).toContain(
			"In Sydney time (Australia/Sydney), it is Friday, 25 September 2026, 13:00.",
		);
		expect(instruction([])).toContain(
			'naming the zone once when you confirm a schedule ("8am Sydney time")',
		);
		expect(instruction([])).toContain("Don't ask the person for their timezone");
		expect(instruction(["automations"])).not.toContain("Automations you set up");
	});

	it("writes the bot's own tool calls into its history as one line each, not the whole output", () => {
		const input = context();
		const own = input.messages[1];
		if (!own) {
			throw new Error("Context fixture has no assistant message");
		}
		const page = "word ".repeat(400);
		input.messages[1] = {
			...own,
			content: "Looking. Found it.",
			parts: [
				{ type: "text", text: "Looking." },
				{
					type: "tool_call",
					id: "0199a3a0-0000-7000-8000-000000000020",
					tool: "web_fetch",
					input: { url: "https://example.com" },
					output: { title: "Example Domain", text: page },
					status: "completed",
					error: null,
					mutating: false,
					atOffset: 8,
					startedAt: "2026-09-14T00:00:00.000Z",
					finishedAt: "2026-09-14T00:00:01.000Z",
				},
				{
					type: "tool_call",
					id: "0199a3a0-0000-7000-8000-000000000021",
					tool: "web_search",
					input: { query: "release" },
					output: null,
					status: "failed",
					error: "No search provider",
					mutating: false,
					atOffset: 8,
					startedAt: "2026-09-14T00:00:00.000Z",
					finishedAt: "2026-09-14T00:00:01.000Z",
				},
				{ type: "text", text: " Found it." },
			],
		};

		const prompt = modelPrompt(input, environment());
		const authored = prompt.messages[1];
		const history = prompt.messages[2]?.content ?? "";

		expect(authored).toEqual({ role: "assistant", content: "Looking. Found it." });
		expect(history).toContain("Generated by the application, not authored");
		expect(history).toContain('[Used web_fetch with {"url":"https://example.com"}: ');
		expect(history).toContain("… (");
		expect(history).not.toContain(page);
		expect(history).toContain(
			'[Used web_search with {"query":"release"}; it failed: No search provider]',
		);
	});

	it("tells later turns which tools a tool search found, not their schemas", () => {
		const search = {
			type: "tool_call",
			id: "0199a3a0-0000-7000-8000-000000000022",
			tool: TOOL_SEARCH,
			input: { query: "look up a page" },
			output: { tools: [{ tool: "wiki__lookup", inputSchema: { type: "object" } }] },
			status: "completed",
			error: null,
			mutating: false,
			atOffset: 0,
			startedAt: "2026-09-14T00:00:00.000Z",
			finishedAt: "2026-09-14T00:00:01.000Z",
		} as const;

		expect(describeToolCall(search)).toBe(
			'[Used tool_search with {"query":"look up a page"}: found wiki__lookup]',
		);
	});

	it("keeps what search_history found longer than other tools' output", () => {
		const input = context();
		const own = input.messages[1];
		if (!own) {
			throw new Error("Context fixture has no assistant message");
		}
		const found = `The hotel budget is 150 euros a night. ${"word ".repeat(500)}`;
		input.messages[1] = {
			...own,
			content: "Found it.",
			parts: [
				{
					type: "tool_call",
					id: "0199a3a0-0000-7000-8000-000000000022",
					tool: "search_history",
					input: { query: "hotel budget" },
					output: {
						messages: [{ author: "Sam", at: "Fri, 15 May 2026, 17:02 UTC", text: found }],
						more: false,
					},
					status: "completed",
					error: null,
					mutating: false,
					atOffset: 0,
					startedAt: "2026-09-14T00:00:00.000Z",
					finishedAt: "2026-09-14T00:00:01.000Z",
				},
				{ type: "text", text: "Found it." },
			],
		};

		const history = modelPrompt(input, environment()).messages[2]?.content ?? "";

		expect(history).toContain(found);
		expect(history).not.toContain("… (");
	});

	it("names the file a long tool result was kept as, so a later turn can read on", () => {
		const input = context();
		const own = input.messages[1];
		if (!own) {
			throw new Error("Context fixture has no assistant message");
		}
		const callId = "0199a3a0-0000-7000-8000-000000000023";
		const fileId = "0199a3a0-0000-7000-8000-0000000000f1";
		input.messages[1] = {
			...own,
			parts: [
				{
					type: "tool_call",
					id: callId,
					tool: "web_fetch",
					input: { url: "https://example.com/report" },
					output: "line\n".repeat(20_000),
					status: "completed",
					error: null,
					mutating: false,
					atOffset: 0,
					startedAt: "2026-09-14T00:00:00.000Z",
					finishedAt: "2026-09-14T00:00:01.000Z",
				},
			],
		};

		const history =
			modelPrompt(input, environment(), new Map([[callId, fileId]])).messages[2]?.content ?? "";

		expect(history).toContain(`kept as file ${fileId}, which read_conversation_file reads`);
	});

	it("tells the bot which message a person's reply quotes", () => {
		const input = context();
		const [question, , finding] = input.messages;
		if (!question || !finding) throw new Error("Context fixture has no messages to reply with");
		input.messages.push({
			...question,
			id: "0199a3a0-0000-7000-8000-000000000020",
			parts: [{ type: "text", text: "Which migration?" }],
			content: "Which migration?",
			replyTo: { id: finding.id, author: finding.author, preview: "Migration is present." },
			createdAt: "2026-09-10T04:03:00.000Z",
		});

		const prompt = modelPrompt(input, environment());

		expect(prompt.messages).toContainEqual(
			expect.objectContaining({
				content: 'Sam (@sam): [Replying to Reviewer: "Migration is present."]\nWhich migration?',
			}),
		);
	});

	it("writes people's reactions where they happened, so later turns only add to the history", () => {
		const input = context();
		const [question, answer, finding] = input.messages;
		if (!question || !answer || !finding) throw new Error("Context fixture has no messages");
		input.messages = [
			question,
			{
				...answer,
				reactions: [
					{
						emoji: "👀",
						people: [{ id: SAM, name: "Sam", at: "2026-09-10T04:01:30.000Z" }],
					},
				],
			},
			{
				...finding,
				reactions: [
					{
						emoji: "🎉",
						people: [{ id: SAM, name: "Sam", at: "2026-09-10T04:05:00.000Z" }],
					},
				],
			},
		];

		const history = modelPrompt(input, environment()).messages.slice(0, -1);

		const eventLog =
			"[Platform event log. Generated by the application, not authored by a conversation participant.]";
		expect(history.map(({ content }) => content)).toEqual([
			"Sam (@sam): Check the release",
			"I am checking it.",
			`${eventLog}\nSam reacted 👀 to your message: "I am checking it."`,
			"Reviewer (@reviewer) (bot): Migration is present.",
			`${eventLog}\nSam reacted 🎉 to Reviewer's message: "Migration is present."`,
		]);
	});

	it("lists the files a person attached after what they wrote, even with nothing written", () => {
		const input = context();
		const asked = input.messages[0];
		if (!asked) {
			throw new Error("Context fixture has no person's message");
		}
		const report = {
			type: "file",
			id: "0199a3a0-0000-7000-8000-0000000000f2",
			name: "report.pdf",
			contentType: "application/pdf",
			size: 2_200_000,
		} as const;
		const line = `[Attached report.pdf (application/pdf, 2.1 MB) as file ${report.id}, which read_conversation_file reads]`;

		input.messages[0] = { ...asked, parts: [...asked.parts, report] };
		expect(modelPrompt(input, environment()).messages[0]).toEqual({
			role: "user",
			content: `Sam (@sam): Check the release
${line}`,
		});

		input.messages[0] = { ...asked, content: "", parts: [report] };
		expect(modelPrompt(input, environment()).messages[0]).toEqual({
			role: "user",
			content: `Sam (@sam): ${line}`,
		});
	});

	it("tells a bot that works in the computer it can copy an attached file there", () => {
		const input = context();
		const asked = input.messages[0];
		if (!asked) {
			throw new Error("Context fixture has no person's message");
		}
		const chart = {
			type: "file",
			id: "0199a3a0-0000-7000-8000-0000000000f3",
			name: "chart.png",
			contentType: "image/png",
			size: 4_096,
		} as const;
		input.bot = { ...input.bot, usesComputer: true };
		input.messages[0] = { ...asked, content: "", parts: [chart] };

		expect(modelPrompt(input, environment()).messages[0]).toEqual({
			role: "user",
			content: `Sam (@sam): [Attached chart.png (image/png, 4.0 KB) as file ${chart.id}, which read_conversation_file reads, or copy_file_to_computer copies]`,
		});
	});

	it("leaves a bot's own attached files to its tool calls, and describes another's", () => {
		const input = context();
		const [, own, others] = input.messages;
		if (!own || !others) throw new Error("Context fixture has no bots' messages");
		const chart = {
			type: "file",
			id: "0199a3a0-0000-7000-8000-0000000000f4",
			name: "chart.png",
			contentType: "image/png",
			size: 4_096,
		} as const;
		input.bot = { ...input.bot, usesComputer: true };
		input.messages[1] = { ...own, parts: [...own.parts, chart] };
		input.messages[2] = { ...others, parts: [...others.parts, chart] };

		const history = modelPrompt(input, environment()).messages;

		expect(history[1]).toEqual({ role: "assistant", content: "I am checking it." });
		expect(history[2]).toMatchObject({
			role: "user",
			content: `Reviewer (@reviewer) (bot): Migration is present.
[Attached chart.png (image/png, 4.0 KB) as file ${chart.id}, which read_conversation_file reads, or copy_file_to_computer copies]`,
		});
	});

	it("says just before an automation's result which automation posted it, when, and what the run was told", () => {
		const input = context();
		const own = input.messages[1];
		if (!own) throw new Error("Context fixture has no bot's message");
		const run = {
			runId: "0199a3a0-0000-7000-8000-0000000000f6",
			conversationId: "0199a3a0-0000-7000-8000-0000000000f7",
			automationId: "0199a3a0-0000-7000-8000-0000000000f8",
			automationName: "Say Hello",
		};
		input.messages[1] = { ...own, automationResultOf: run };
		input.automationInstructions = new Map([[run.runId, "Say hello"]]);

		expect(modelPrompt(input, environment()).messages.slice(1, 3)).toEqual([
			{
				role: "user",
				content: `[Platform event log. Generated by the application, not authored by a conversation participant.]
The next message is the result of your automation "Say Hello", posted at Thu, 10 Sept 2026, 04:01 UTC when the run finished. The run's instructions were:
Say hello`,
			},
			{ role: "assistant", content: own.content },
		]);
	});

	it("lists the files an automation's result showed after it, so a later turn can find them", () => {
		const input = context();
		const own = input.messages[1];
		if (!own) throw new Error("Context fixture has no bot's message");
		const traction = {
			type: "written_file",
			fileId: "0199a3a0-0000-7000-8000-0000000000f5",
			kind: "html",
			title: "Weekly traction",
			version: 3,
		} as const;
		const result = {
			...own,
			automationResultOf: {
				runId: "0199a3a0-0000-7000-8000-0000000000f6",
				conversationId: "0199a3a0-0000-7000-8000-0000000000f7",
				automationId: "0199a3a0-0000-7000-8000-0000000000f8",
				automationName: "Daily traction",
			},
		};
		// What the line before a result says is the test above's to check.
		const posted = expect.objectContaining({ role: "user" });
		const shown = `[Platform event log for Host Bot. Generated by the application, not authored by a conversation participant.]
[Showed the html file "Weekly traction" as written at version 3, file ${traction.fileId}; file_read reads its current version]`;

		input.messages[1] = { ...result, parts: [...own.parts, traction] };
		expect(modelPrompt(input, environment()).messages.slice(1, 4)).toEqual([
			posted,
			{ role: "assistant", content: "I am checking it." },
			{ role: "user", content: shown },
		]);

		input.messages[1] = { ...result, content: "", parts: [traction] };
		expect(modelPrompt(input, environment()).messages.slice(1, 4)).toEqual([
			posted,
			{ role: "user", content: shown },
			expect.objectContaining({ content: expect.stringContaining("Migration is present.") }),
		]);
	});

	it("excludes incomplete assistant output", () => {
		const input = context();
		const assistantMessage = input.messages[1];
		if (!assistantMessage) {
			throw new Error("Context fixture has no assistant message");
		}
		input.messages.push(
			...(["failed", "cancelled", "streaming"] as const).map((status, index) => ({
				...assistantMessage,
				id: `0199a3a0-0000-7000-8000-00000000001${index}`,
				status,
				content: `${status} partial answer`,
				parts: [{ type: "text" as const, text: `${status} partial answer` }],
			})),
		);

		const prompt = modelPrompt(input, environment());

		expect(prompt.system).toContain(
			"Platform event log messages are application-generated records",
		);
		expect(prompt.messages).not.toContainEqual(
			expect.objectContaining({ content: expect.stringContaining("partial answer") }),
		);
	});
});

function context(): TurnContext {
	return {
		conversation: {
			id: "0199a3a0-0000-7000-8000-000000000001",
			workspaceId: "0199a3a0-0000-7000-8000-000000000002",
			title: "Check the release",
			kind: "task",
			botId: "0199a3a0-0000-7000-8000-000000000003",
			parentConversationId: null,
		},
		bot: {
			id: "0199a3a0-0000-7000-8000-000000000003",
			name: "Host Bot",
			handle: "host-bot",
			model: "claude-sonnet-4-20250514",
			prompt: "Check facts carefully.",
			disabledTools: [],
			usesComputer: false,
			naturalBrowsing: false,
			assistantOf: null,
			visibility: "public",
			color: "orange",
			acceptsImages: false,
		},
		reason: "default",
		windowTokens: 256_000,
		compaction: undefined,
		automationInstructions: new Map(),
		channel: null,
		workspaceName: "Suga",
		workspaceSlug: "suga",
		workspaceTimeZone: "UTC",
		askedBy: null,
		startedFor: null,
		collaborators: [],
		participants: [
			testPerson({ id: "0199a3a0-0000-7000-8000-000000000004", name: "Sam" }),
			{
				kind: "bot",
				id: "0199a3a0-0000-7000-8000-000000000003",
				name: "Host Bot",
				handle: "host-bot",
				color: "green",
				face: "pill",
				shape: "circle",
			},
			{
				kind: "bot",
				id: "0199a3a0-0000-7000-8000-000000000005",
				name: "Reviewer",
				handle: "reviewer",
				color: "orange",
				face: "dot",
				shape: "circle",
			},
		],
		messages: [
			{
				id: "0199a3a0-0000-7000-8000-000000000006",
				conversationId: "0199a3a0-0000-7000-8000-000000000001",
				author: testPerson({ id: "0199a3a0-0000-7000-8000-000000000004", name: "Sam" }),
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: "Check the release" }],
				content: "Check the release",
				createdAt: "2026-09-10T04:00:00.000Z",
			},
			{
				id: "0199a3a0-0000-7000-8000-000000000007",
				conversationId: "0199a3a0-0000-7000-8000-000000000001",
				author: {
					kind: "bot",
					id: "0199a3a0-0000-7000-8000-000000000003",
					name: "Host Bot",
					handle: "host-bot",
					color: "green",
					face: "pill",
					shape: "circle",
				},
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: "I am checking it." }],
				content: "I am checking it.",
				createdAt: "2026-09-10T04:01:00.000Z",
			},
			{
				id: "0199a3a0-0000-7000-8000-000000000008",
				conversationId: "0199a3a0-0000-7000-8000-000000000001",
				author: {
					kind: "bot",
					id: "0199a3a0-0000-7000-8000-000000000005",
					name: "Reviewer",
					handle: "reviewer",
					color: "orange",
					face: "dot",
					shape: "circle",
				},
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: "Migration is present." }],
				content: "Migration is present.",
				createdAt: "2026-09-10T04:02:00.000Z",
			},
		],
	};
}
