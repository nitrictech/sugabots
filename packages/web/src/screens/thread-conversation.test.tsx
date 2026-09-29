import type {
	AgentParticipant,
	Connection,
	Message,
	MessagePart,
	SessionUser,
	ToolCallPart,
} from "@sugabots/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/lib/query.ts";
import { client } from "@/test-client.ts";
import { ThreadConversation } from "./ThreadConversation.tsx";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const POD = "0199a3a0-0000-7000-8000-0000000000b1";
const THREAD = "0199a3a0-0000-7000-8000-0000000000b2";

const host: AgentParticipant = {
	kind: "agent",
	id: "0199a3a0-0000-7000-8000-0000000000b3",
	name: "Linear Handler",
	handle: "linear-handler",
	color: "green",
	face: "pill",
};

const user: SessionUser = {
	id: "0199a3a0-0000-7000-8000-0000000000b4",
	name: "Ryan Eyes",
	email: "ryan@example.com",
	image: null,
} as SessionUser;

let nextId = 0;

function toolCall(tool: string, over: Partial<ToolCallPart> = {}): ToolCallPart {
	nextId += 1;
	return {
		type: "tool_call",
		id: `0199a3a0-0000-7000-8000-${String(nextId).padStart(12, "0")}`,
		tool,
		input: { query: "timeout" },
		output: { found: 3 },
		status: "completed",
		error: null,
		mutating: false,
		atOffset: 0,
		startedAt: "2026-09-18T09:00:00.000Z",
		finishedAt: "2026-09-18T09:00:01.400Z",
		...over,
	};
}

function reply(parts: MessagePart[], over: Partial<Message> = {}): Message {
	const content = parts.map((part) => (part.type === "text" ? part.text : "")).join("");
	return {
		id: "0199a3a0-0000-7000-8000-0000000000c1",
		threadId: THREAD,
		author: host,
		kind: "text",
		status: "complete",
		parts,
		content,
		createdAt: "2026-09-18T09:00:02.000Z",
		...over,
	};
}

function connection(handle: string, name: string, url: string): Connection {
	return {
		id: `0199a3a0-0000-7000-8000-00000000${handle.length}aa1`,
		workspaceId: "0199a3a0-0000-7000-8000-0000000000a1",
		podId: POD,
		name,
		handle,
		url,
		auth: "oauth",
		signedIn: true,
		secretHeader: null,
		hasSecret: false,
		access: "allow",
		status: "connected",
		tools: [],
		lastTestedAt: null,
		lastTestError: null,
		createdAt: "2026-09-18T08:00:00.000Z",
	};
}

/** Renders the thread, and returns `update` to redraw it as a live thread would. */
function show(
	messages: Message[],
	over: { canApprove?: boolean; participants?: AgentParticipant[] } = {},
) {
	const queryClient = createQueryClient();
	const thread = (shown: Message[]) => (
		<QueryClientProvider client={queryClient}>
			<ThreadConversation
				messages={shown}
				host={host}
				isRunning={false}
				participants={over.participants ?? [host]}
				user={user}
				podId={POD}
				onOpenCollaboration={() => undefined}
				dividers={false}
				canApproveToolCalls={over.canApprove ?? true}
			/>
		</QueryClientProvider>
	);
	const view = render(thread(messages));
	return { update: (shown: Message[]) => view.rerender(thread(shown)) };
}

beforeEach(() => {
	client.api.connections.list.mockReturnValue(
		Effect.succeed([
			connection("sentry", "Sentry", "https://mcp.sentry.dev/mcp"),
			connection("linear", "Linear", "https://mcp.linear.app/mcp"),
		]),
	);
	client.api.toolApprovals.decide.mockReturnValue(Effect.undefined);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("what people and bots write", () => {
	it("renders a bot's Markdown without interpreting a person's", async () => {
		const asked = "Is **this** bold?";
		const answered = "**Tim's bill** is high.\n\n- Look up plans\n- Draft a note";
		show([
			reply([{ type: "text", text: asked }], {
				id: "0199a3a0-0000-7000-8000-0000000000c0",
				author: {
					kind: "person",
					id: user.id,
					name: user.name,
					handle: "ryan-eyes",
					image: null,
				},
				createdAt: "2026-09-18T09:00:00.000Z",
			}),
			reply([{ type: "text", text: answered }]),
		]);

		expect((await screen.findByText("Tim's bill")).getAttribute("data-streamdown")).toBe("strong");
		expect(screen.getByText("Look up plans").tagName).toBe("LI");
		expect(screen.getByText(asked)).toBeDefined();
	});
});

describe("a finished reply that used tools", () => {
	const answered = reply([
		toolCall("sentry__search_issues"),
		toolCall("sentry__search_issues"),
		toolCall("sentry__search_issues"),
		toolCall("linear__list_issues"),
		{ type: "text", text: "Yes — 41 events, all on checkout." },
	]);

	it("shows the answer, and what it used on one line above it", async () => {
		show([answered]);

		expect(screen.getByText("Yes — 41 events, all on checkout.")).toBeDefined();
		expect(
			await screen.findByRole("button", { name: /Used Sentry and Linear for 6s/ }),
		).toBeDefined();
		expect(screen.queryByText("Search issues")).toBeNull();
	});

	it("lists each call when its line is opened", async () => {
		show([answered]);

		const line = await screen.findByRole("button", { name: /Used Sentry and Linear/ });
		fireEvent.click(line);

		expect(line.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getAllByText("Search issues")).toHaveLength(3);
		expect(screen.getByText("List issues")).toBeDefined();
	});
});

describe("a reply that wrote a line before each tool call", () => {
	const narrated = reply([
		{ type: "text", text: "Let me find the current cycle:" },
		toolCall("linear__get_cycle"),
		{ type: "text", text: "Now the issues in it:" },
		toolCall("linear__list_issues"),
		{ type: "text", text: "Here are the 2 issues in Cycle 33." },
	]);

	it("shows only the answer: what it said on the way is the tool line's to stand for", async () => {
		show([narrated]);

		const bubble = screen.getByRole("article");
		expect(bubble.textContent).toContain("Here are the 2 issues in Cycle 33.");
		expect(bubble.textContent).not.toContain("Let me find the current cycle:");
		expect(await screen.findByRole("button", { name: /Used Linear/ })).toBeDefined();
	});
});

describe("a reply arriving", () => {
	const answer: MessagePart = { type: "text", text: "Here are the 2 issues in Cycle 33." };

	it("grows to fit its words when it finished while the thread was open", () => {
		const { update } = show([reply([answer], { status: "streaming" })]);

		update([reply([answer])]);

		const words = screen.getByText("Here are the 2 issues in Cycle 33.");
		expect(words.closest(".reply-grow")).not.toBeNull();
	});

	it("simply shows a reply that was already finished when the thread opened", () => {
		show([reply([answer])]);

		const words = screen.getByText("Here are the 2 issues in Cycle 33.");
		expect(words.closest(".reply-grow")).toBeNull();
	});
});

describe("a reply that opens by asking another bot", () => {
	const helper: AgentParticipant = {
		...host,
		id: "0199a3a0-0000-7000-8000-0000000000b5",
		name: "Sentry Scout",
		handle: "sentry-scout",
	};
	const asked = reply([
		{
			type: "collaboration",
			id: "0199a3a0-0000-7000-8000-0000000000c2",
			agentId: helper.id,
			agentName: helper.name,
			threadId: "0199a3a0-0000-7000-8000-0000000000c3",
			brief: "Check Sentry",
			status: "answered",
			answer: "41 events",
			atOffset: 0,
		},
		{ type: "text", text: "Sentry Scout found 41 events." },
	]);

	it("names the bot above its message, not above the collaboration line", async () => {
		show([asked], { participants: [host, helper] });

		const line = await screen.findByRole("button", { name: /collaborated with Sentry Scout/ });
		const name = screen.getByText(host.name, { selector: "div" });
		expect(line.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});
});

describe("a reply that wrote nothing but used tools", () => {
	// A turn that called a tool and produced no text has no text part at all —
	// `messagePartsFor` adds none when the content is empty. It still needs a
	// bubble: that is where a failure shows.
	const wordless = reply([toolCall("sentry__search_issues")], { content: "" });

	it("still shows who replied, and what it used", async () => {
		show([wordless]);

		expect(await screen.findByRole("button", { name: /Used Sentry/ })).toBeDefined();
		expect(screen.getByLabelText(/Linear Handler/)).toBeDefined();
	});

	it("still says a reply failed when it failed without words", async () => {
		show([
			reply([toolCall("sentry__search_issues")], {
				content: "",
				status: "failed",
				error: "Ran out of context",
			}),
		]);

		expect(await screen.findByText("Reply failed.")).toBeDefined();
		expect(screen.getByText(/Ran out of context/)).toBeDefined();
	});
});

describe("a reply still being written", () => {
	const answer: MessagePart = { type: "text", text: "Here are the 2 issues in Cycle 33." };

	it("shows none of it until it is finished, only that the bot is typing and what it is using", async () => {
		const search = toolCall("sentry__search_issues", {
			status: "running",
			output: null,
			finishedAt: null,
		});
		const { update } = show([
			reply([{ type: "text", text: "Let me look" }], { status: "streaming" }),
		]);
		expect(screen.queryByRole("article")).toBeNull();
		expect(screen.getByRole("status", { name: "Linear Handler is typing" })).toBeDefined();

		update([reply([search], { status: "streaming" })]);
		expect(await screen.findByRole("button", { name: /Using Sentry/ })).toBeDefined();

		update([reply([{ ...search, status: "completed", finishedAt: search.startedAt }, answer])]);
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.getByRole("article").textContent).toContain("Here are the 2 issues in Cycle 33.");
	});

	it("says the bot is typing between one call and the next", () => {
		show([reply([toolCall("sentry__search_issues")], { status: "streaming" })]);

		expect(screen.getByRole("status", { name: "Linear Handler is typing" })).toBeDefined();
	});

	it("gives way to a write waiting on approval, which says so itself", async () => {
		show([
			reply(
				[
					toolCall("linear__create_issue", {
						status: "awaiting_approval",
						output: null,
						finishedAt: null,
						mutating: true,
						approval: { status: "pending", decidedByName: null, decidedAt: null },
					}),
				],
				{ status: "streaming" },
			),
		]);

		expect(await screen.findByRole("button", { name: "Allow" })).toBeDefined();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("types again once the write is allowed, before it starts", async () => {
		show([
			reply(
				[
					toolCall("linear__create_issue", {
						status: "awaiting_approval",
						output: null,
						finishedAt: null,
						mutating: true,
						approval: { status: "allowed", decidedByName: "Ryan Eyes", decidedAt: null },
					}),
				],
				{ status: "streaming" },
			),
		]);

		const line = await screen.findByRole("button", { name: /Using Linear/ });
		expect(screen.getByRole("status", { name: "Linear Handler is typing" })).toBeDefined();
		expect(screen.queryByRole("region", { name: /Approval needed/ })).toBeNull();
		fireEvent.click(line);
		expect(screen.getByText("Allowed by Ryan Eyes")).toBeDefined();
	});
});

describe("a write that needs approving", () => {
	const pending = toolCall("linear__create_issue", {
		status: "awaiting_approval",
		output: null,
		finishedAt: null,
		mutating: true,
		input: { team: "Platform", title: "Checkout requests time out" },
		approval: { status: "pending", decidedByName: null, decidedAt: null },
	});
	const asking = reply([{ type: "text", text: "I want to open an issue." }, pending]);

	it("stops the thread, says so on its tool line, and shows what it would send on request", async () => {
		show([asking]);

		expect(
			await screen.findByRole("region", { name: "Approval needed: Create issue in Linear" }),
		).toBeDefined();
		expect(screen.getByRole("button", { name: /Waiting on Linear approval/ })).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: /View the full request/ }));
		const request = await screen.findByRole("dialog");
		expect(within(request).getByText("Team")).toBeDefined();
		expect(within(request).getByText("Platform")).toBeDefined();
	});

	it("allows it once, with no standing permission offered here", async () => {
		const approval = client.api.toolApprovals.decide;
		show([asking]);

		fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].payload).toEqual({ decision: "allow_once" });
		expect(screen.queryByRole("checkbox")).toBeNull();
	});

	it("sends a refusal when denied", async () => {
		const approval = client.api.toolApprovals.decide;
		show([asking]);

		fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].payload).toEqual({ decision: "deny" });
	});

	it("says so when the viewer is not the one who can answer", async () => {
		show([asking], { canApprove: false });

		expect(
			await screen.findByText("Waiting for someone with permission to answer this."),
		).toBeDefined();
		expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
	});

	it("says on its tool line when it was refused, and by whom when opened", async () => {
		show([
			reply([
				{ type: "text", text: "Left it untracked." },
				toolCall("linear__create_issue", {
					status: "awaiting_approval",
					output: null,
					finishedAt: null,
					mutating: true,
					approval: { status: "denied", decidedByName: "Ryan Eyes", decidedAt: null },
				}),
			]),
		]);

		const line = await screen.findByRole("button", { name: /Linear denied/ });
		fireEvent.click(line);
		expect(screen.getByText("Denied by Ryan Eyes")).toBeDefined();
		expect(screen.queryByRole("region", { name: /Approval needed/ })).toBeNull();
	});
});
