import type {
	AgentParticipant,
	Message,
	MessagePart,
	SessionUser,
	ToolCallPart,
} from "@sugabots/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/lib/query.ts";
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

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
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
