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
	hue: 158,
	face: "bar",
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
		enabled: true,
		allowMutating: true,
		status: "connected",
		tools: [],
		lastTestedAt: null,
		lastTestError: null,
		createdAt: "2026-09-18T08:00:00.000Z",
	};
}

/** Renders the thread, and returns `update` to redraw it as a live thread would. */
function show(messages: Message[], over: { canApprove?: boolean; canAlwaysAllow?: boolean } = {}) {
	const queryClient = createQueryClient();
	const thread = (shown: Message[]) => (
		<QueryClientProvider client={queryClient}>
			<ThreadConversation
				messages={shown}
				host={host}
				isRunning={false}
				mentionable={[host]}
				user={user}
				podId={POD}
				dividers={false}
				canApproveToolCalls={over.canApprove ?? true}
				canAlwaysAllowToolCalls={over.canAlwaysAllow ?? false}
			/>
		</QueryClientProvider>
	);
	const view = render(thread(messages));
	return { update: (shown: Message[]) => view.rerender(thread(shown)) };
}

beforeEach(() => {
	client.api.pods[":podId"].connections.$get.mockResolvedValue(
		Response.json([
			connection("sentry", "Sentry", "https://mcp.sentry.dev/mcp"),
			connection("linear", "Linear", "https://mcp.linear.app/mcp"),
		]),
	);
	client.api.pods[":podId"]["tool-calls"][":toolCallId"].approval.$post.mockResolvedValue(
		new Response(null, { status: 204 }),
	);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("a finished reply that used tools", () => {
	const answered = reply([
		toolCall("sentry__search_issues"),
		toolCall("sentry__search_issues"),
		toolCall("sentry__search_issues"),
		toolCall("linear__list_issues"),
		{ type: "text", text: "Yes — 41 events, all on checkout." },
	]);

	it("leaves nothing in the thread but the answer", () => {
		show([answered]);

		expect(screen.getByText("Yes — 41 events, all on checkout.")).toBeDefined();
		expect(screen.queryByText(/search_issues/)).toBeNull();
		expect(screen.queryByText(/list_issues/)).toBeNull();
	});

	it("opens the steps behind the message, counted, from its action bar", async () => {
		show([answered]);

		fireEvent.click(await screen.findByRole("button", { name: "Show activity · 4 steps" }));

		const log = await screen.findByRole("dialog");
		expect(log.textContent).toContain("4 steps");
		expect(within(log).getByText("Sentry ·")).toBeDefined();
		expect(within(log).getByText("Linear ·")).toBeDefined();
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

	it("shows the answer in the thread, and what it said on the way in the log", async () => {
		show([narrated]);

		const bubble = screen.getByRole("article");
		expect(bubble.textContent).toContain("Here are the 2 issues in Cycle 33.");
		expect(bubble.textContent).not.toContain("Let me find the current cycle:");

		fireEvent.click(await screen.findByRole("button", { name: "Show activity · 2 steps" }));
		const log = await screen.findByRole("dialog");
		expect(within(log).getByText("Let me find the current cycle:")).toBeDefined();
		expect(within(log).getByText("Now the issues in it:")).toBeDefined();
	});
});

describe("a reply that wrote nothing but used tools", () => {
	// A turn that called a tool and produced no text has no text part at all —
	// `messagePartsFor` adds none when the content is empty. The bubble is where
	// the author, the time, a failure and the way into the log all live, so
	// without one the whole message would be invisible.
	const wordless = reply([toolCall("sentry__search_issues")], { content: "" });

	it("still shows who replied, and the way into what it did", async () => {
		show([wordless]);

		expect(await screen.findByRole("button", { name: "Show activity · 1 step" })).toBeDefined();
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

		expect(await screen.findByText("Reply failed")).toBeDefined();
		expect(screen.getByText(/Ran out of context/)).toBeDefined();
	});
});

describe("a reply still using its tools", () => {
	it("says what is happening on one line, and draws no cards", () => {
		show([
			reply(
				[
					{ type: "text", text: "" },
					toolCall("sentry__search_issues", {
						status: "running",
						output: null,
						finishedAt: null,
					}),
				],
				{ status: "streaming" },
			),
		]);

		// The service is shown as its mark, so its name is only in the accessible text.
		expect(screen.getByText(/Search issues/)).toBeDefined();
		expect(screen.getByText("Sentry:", { selector: ".sr-only" })).toBeDefined();
		expect(screen.getByText("is using")).toBeDefined();
		expect(screen.queryByRole("button", { name: /Show activity/ })).toBeNull();
	});
});

describe("a reply still being written", () => {
	const answer: MessagePart = { type: "text", text: "Here are the 2 issues in Cycle 33." };

	it("shows none of it until it is finished, only that the agent is typing", () => {
		const search = toolCall("sentry__search_issues", {
			status: "running",
			output: null,
			finishedAt: null,
		});
		const { update } = show([
			reply([{ type: "text", text: "Let me look" }], { status: "streaming" }),
		]);
		expect(screen.queryByRole("article")).toBeNull();
		expect(screen.getByRole("status", { name: "Linear Handler, typing" })).toBeDefined();
		expect(screen.getByText("is typing")).toBeDefined();

		update([reply([search], { status: "streaming" })]);
		expect(screen.getByText(/Search issues/)).toBeDefined();

		update([reply([{ ...search, status: "completed", finishedAt: search.startedAt }, answer])]);
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.getByRole("article").textContent).toContain("Here are the 2 issues in Cycle 33.");
	});

	it("says the agent is typing between one call and the next", () => {
		show([reply([toolCall("sentry__search_issues")], { status: "streaming" })]);

		expect(screen.getByText("is typing")).toBeDefined();
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

		expect(await screen.findByRole("button", { name: "Approve" })).toBeDefined();
		expect(screen.queryByRole("status")).toBeNull();
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

	it("stops the thread and shows what it would send, as fields", async () => {
		show([asking]);

		expect(
			await screen.findByRole("region", { name: "Approval needed: Create issue in Linear" }),
		).toBeDefined();
		expect(screen.getByText("Paused — needs your approval")).toBeDefined();
		expect(screen.getByText("team")).toBeDefined();
		expect(screen.getByText("Platform")).toBeDefined();
	});

	it("allows it once by default, and always when that is ticked", async () => {
		const approval = client.api.pods[":podId"]["tool-calls"][":toolCallId"].approval.$post;
		show([asking], { canAlwaysAllow: true });

		fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].json).toEqual({ decision: "allow_once" });

		cleanup();
		approval.mockClear();
		show([asking], { canAlwaysAllow: true });
		fireEvent.click(await screen.findByRole("checkbox"));
		fireEvent.click(screen.getByRole("button", { name: "Approve" }));
		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].json).toEqual({ decision: "always_allow" });
	});

	it("sends a refusal when denied", async () => {
		const approval = client.api.pods[":podId"]["tool-calls"][":toolCallId"].approval.$post;
		show([asking]);

		fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].json).toEqual({ decision: "deny" });
	});

	it("says so when the viewer is not the one who can answer", async () => {
		show([asking], { canApprove: false });

		expect(
			await screen.findByText("Waiting for someone with permission to answer this."),
		).toBeDefined();
		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
	});

	it("leaves a line behind when it was refused, unlike everything else", async () => {
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

		expect(await screen.findByText(/Ryan Eyes denied/)).toBeDefined();
		expect(screen.getByText("Create issue in Linear")).toBeDefined();
		expect(screen.getByRole("button", { name: "Review" })).toBeDefined();
	});
});
