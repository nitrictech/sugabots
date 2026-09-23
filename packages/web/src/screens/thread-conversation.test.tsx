import type {
	AgentParticipant,
	Connection,
	Message,
	MessagePart,
	SessionUser,
	ToolCallPart,
} from "@sugabots/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
	client.api.connections.list.mockReturnValue(
		Effect.succeed([
			connection("sentry", "Sentry", "https://mcp.sentry.dev/mcp"),
			connection("linear", "Linear", "https://mcp.linear.app/mcp"),
		]),
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

	it("opens the steps behind the message, counted, from its action bar", async () => {
		show([answered]);

		fireEvent.click(await screen.findByRole("button", { name: "Show activity · 4 steps" }));

		const log = await screen.findByRole("dialog");
		expect(log.textContent).toContain("4 steps");
		expect(within(log).getByText("Sentry ·")).toBeDefined();
		expect(within(log).getByText("Linear ·")).toBeDefined();
	});
});

describe("a reply still being written", () => {
	const answer: MessagePart = { type: "text", text: "Here are the 2 issues in Cycle 33." };

	it("shows none of it until it is finished, only that the agent is typing", () => {
		const { update } = show([
			reply([{ type: "text", text: "Let me look" }], { status: "streaming" }),
		]);
		expect(screen.queryByRole("article", { name: /Linear Handler/ })).toBeNull();
		expect(screen.getByRole("status", { name: "Linear Handler, typing" })).toBeDefined();
		expect(screen.getByText("is typing")).toBeDefined();

		update([reply([answer])]);
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.getByRole("article").textContent).toContain("Here are the 2 issues in Cycle 33.");
	});

	it("gives way to a write waiting on approval, which says so itself", () => {
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

		expect(screen.queryByRole("status")).toBeNull();
	});
});
