import { testPerson } from "@sugabots/contracts/testing";
import { describe, expect, it } from "vitest";
import { describeToolCall } from "../threads/message-text.ts";
import { TOOL_SEARCH } from "../tools/tool-search/tool.ts";
import { modelPrompt, type TurnEnvironment } from "./context.ts";
import type { TurnContext } from "./execution.ts";

const environment = (overrides: Partial<TurnEnvironment> = {}): TurnEnvironment => ({
	now: new Date("2026-09-25T03:00:00Z"),
	builtInTools: [],
	connectionTools: undefined,
	...overrides,
});

describe("modelPrompt", () => {
	it("maps people and other agents to attributed user messages", () => {
		const prompt = modelPrompt(context(), environment());

		expect(prompt.system).toContain(
			"You are Host Agent (@host-agent), an agent in pod Release of workspace Suga",
		);
		expect(prompt.system).toContain("Check facts carefully.");
		// The history, then one trailing instruction with everything that varies
		// between turns, so the prefix the provider caches never changes shape.
		expect(prompt.messages.slice(0, -1)).toEqual([
			{ role: "user", content: "Sam (@sam): Check the release" },
			{ role: "assistant", content: "I am checking it." },
			{ role: "user", content: "Reviewer (@reviewer) (agent): Migration is present." },
		]);
		const instruction = prompt.messages.at(-1);
		expect(instruction?.role).toBe("user");
		expect(instruction?.content).toContain(
			"In the thread now: Sam (@sam, person), Host Agent (@host-agent, agent), Reviewer (@reviewer, agent).",
		);
		expect(instruction?.content).toContain(
			"It is your turn as the agent this thread was addressed to.",
		);
		expect(prompt.system).not.toContain("Sam (@sam, person)");
	});

	it("lists potential collaborators, and tells one why its thread exists", () => {
		const asking = context();
		asking.crew = [
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
			"Other agents in this pod, and what each one knows:\n- Reviewer (@reviewer): Checks facts.\n- Scout (@scout)",
		);
		expect(instruction()).toContain(
			"Use the collaborate tool when you need another agent's answer",
		);
		expect(instruction()).not.toContain("callout tool");
		expect(modelPrompt(context(), environment()).messages.at(-1)?.content).not.toContain(
			"collaborate tool",
		);

		const collaboration = context();
		collaboration.thread.parentThreadId = "0199a3a0-0000-7000-8000-000000000010";
		expect(modelPrompt(collaboration, environment()).system).toContain(
			"Another agent opened this thread",
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

	it("grounds the turn in today's date and in what the agent can check", () => {
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

	it("gives the time where its routines run, named as people say it, so it need not ask", () => {
		const instruction = (disabledTools: string[]) =>
			modelPrompt(
				{
					...context(),
					workspaceTimeZone: "Australia/Sydney",
					agent: { ...context().agent, disabledTools },
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
		expect(instruction(["routines"])).not.toContain("Routines you set up");
	});

	it("writes the agent's own tool calls into its history as one line each, not the whole output", () => {
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
		thread: {
			id: "0199a3a0-0000-7000-8000-000000000001",
			workspaceId: "0199a3a0-0000-7000-8000-000000000002",
			title: "Check the release",
			parentThreadId: null,
		},
		agent: {
			id: "0199a3a0-0000-7000-8000-000000000003",
			podId: "0199a3a0-0000-7000-8000-000000000009",
			name: "Host Agent",
			handle: "host-agent",
			model: "claude-sonnet-4-20250514",
			prompt: "Check facts carefully.",
			disabledTools: [],
			interviewing: false,
		},
		reason: "default",
		routing: { facilitator: false },
		windowTokens: 256_000,
		compaction: undefined,
		podName: "Release",
		workspaceName: "Suga",
		workspaceTimeZone: "UTC",
		askedBy: null,
		crew: [],
		participants: [
			testPerson({ id: "0199a3a0-0000-7000-8000-000000000004", name: "Sam" }),
			{
				kind: "agent",
				id: "0199a3a0-0000-7000-8000-000000000003",
				name: "Host Agent",
				handle: "host-agent",
				color: "green",
				face: "pill",
			},
			{
				kind: "agent",
				id: "0199a3a0-0000-7000-8000-000000000005",
				name: "Reviewer",
				handle: "reviewer",
				color: "orange",
				face: "dot",
			},
		],
		messages: [
			{
				id: "0199a3a0-0000-7000-8000-000000000006",
				threadId: "0199a3a0-0000-7000-8000-000000000001",
				author: testPerson({ id: "0199a3a0-0000-7000-8000-000000000004", name: "Sam" }),
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: "Check the release" }],
				content: "Check the release",
				createdAt: "2026-09-10T04:00:00.000Z",
			},
			{
				id: "0199a3a0-0000-7000-8000-000000000007",
				threadId: "0199a3a0-0000-7000-8000-000000000001",
				author: {
					kind: "agent",
					id: "0199a3a0-0000-7000-8000-000000000003",
					name: "Host Agent",
					handle: "host-agent",
					color: "green",
					face: "pill",
				},
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: "I am checking it." }],
				content: "I am checking it.",
				createdAt: "2026-09-10T04:01:00.000Z",
			},
			{
				id: "0199a3a0-0000-7000-8000-000000000008",
				threadId: "0199a3a0-0000-7000-8000-000000000001",
				author: {
					kind: "agent",
					id: "0199a3a0-0000-7000-8000-000000000005",
					name: "Reviewer",
					handle: "reviewer",
					color: "orange",
					face: "dot",
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
