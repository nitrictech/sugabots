import type { Message, ToolCallPart } from "@sugabots/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/lib/query.ts";
import { withPlacedPart } from "@/lib/thread-events.ts";
import { client } from "@/test-client.ts";
import { ToolCallRow } from "./ToolCallRow.tsx";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const call: ToolCallPart = {
	type: "tool_call",
	id: "0199a3a0-0000-7000-8000-0000000000aa",
	tool: "web_fetch",
	input: { url: "https://example.com" },
	output: { title: "Example Domain" },
	status: "completed",
	error: null,
	mutating: false,
	atOffset: 8,
	startedAt: "2026-09-14T00:00:00.000Z",
	finishedAt: "2026-09-14T00:00:01.250Z",
};

afterEach(cleanup);

describe("a tool call row", () => {
	it("says which tool and how long, and opens to the input and output", () => {
		render(<ToolCallRow call={call} />);

		screen.getByRole("region", { name: "Used web_fetch, 1.3 s" });
		expect(screen.queryByText(/example\.com/)).toBeNull();

		fireEvent.click(screen.getByRole("button", { expanded: false }));

		expect(screen.getByText(/"url": "https:\/\/example\.com"/)).toBeDefined();
		expect(screen.getByText(/"title": "Example Domain"/)).toBeDefined();
	});

	it("marks a call that may have changed something", () => {
		render(<ToolCallRow call={{ ...call, tool: "wiki__wipe", mutating: true }} />);
		expect(screen.getByText("acted")).toBeDefined();
		cleanup();

		render(<ToolCallRow call={call} />);
		expect(screen.queryByText("acted")).toBeNull();
	});

	it("shows a running call as working and a failed one with its error", () => {
		render(<ToolCallRow call={{ ...call, status: "running", output: null, finishedAt: null }} />);
		expect(screen.getByRole("region", { name: "Used web_fetch, working…" })).toBeDefined();
		cleanup();

		render(
			<ToolCallRow
				call={{ ...call, status: "failed", output: null, error: "Host did not resolve" }}
			/>,
		);
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByRole("region", { name: "Used web_fetch, failed" })).toBeDefined();
		expect(screen.getByText("Host did not resolve")).toBeDefined();
	});

	it("asks before a pending mutation and submits the selected decision", async () => {
		const pending: ToolCallPart = {
			...call,
			tool: "linear__create_issue",
			status: "awaiting_approval",
			output: null,
			finishedAt: null,
			mutating: true,
			approval: { status: "pending", decidedByName: null, decidedAt: null },
		};
		client.api.pods[":podId"]["tool-calls"][":toolCallId"].approval.$post.mockResolvedValue(
			Response.json(pending),
		);
		render(
			<QueryClientProvider client={createQueryClient()}>
				<ToolCallRow
					call={pending}
					threadId="0199a3a0-0000-7000-8000-000000000001"
					podId="0199a3a0-0000-7000-8000-000000000002"
					canApprove
					canAlwaysAllow
				/>
			</QueryClientProvider>,
		);

		expect(screen.getByText("Requested input")).toBeDefined();
		expect(screen.getByRole("button", { name: "Always allow" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Allow once" }));

		await waitFor(() =>
			expect(
				client.api.pods[":podId"]["tool-calls"][":toolCallId"].approval.$post,
			).toHaveBeenCalledWith({
				param: {
					podId: "0199a3a0-0000-7000-8000-000000000002",
					toolCallId: call.id,
				},
				json: { decision: "allow_once" },
			}),
		);
	});

	it("shows a denied mutation without claiming that it acted", () => {
		render(
			<ToolCallRow
				call={{
					...call,
					tool: "linear__create_issue",
					mutating: true,
					approval: {
						status: "denied",
						decidedByName: "Sam",
						decidedAt: "2026-09-14T00:00:01.250Z",
					},
				}}
			/>,
		);

		expect(
			screen.getByRole("region", { name: "Denied linear__create_issue, denied" }),
		).toBeDefined();
		expect(screen.queryByText("acted")).toBeNull();
	});
});

describe("a tool call event on a streaming reply", () => {
	const reply: Message = {
		id: "0199a3a0-0000-7000-8000-000000000012",
		threadId: "0199a3a0-0000-7000-8000-000000000001",
		author: {
			kind: "agent",
			id: "0199a3a0-0000-7000-8000-000000000003",
			name: "Host",
			handle: "host",
			hue: 1,
			face: "bar",
		},
		kind: "text",
		status: "streaming",
		parts: [{ type: "text", text: "Looking. Found it." }],
		content: "Looking. Found it.",
		createdAt: "2026-09-14T00:00:00.000Z",
	};

	it("places the call in the text where it was made, and replaces it when it completes", () => {
		const running: ToolCallPart = { ...call, status: "running", output: null, finishedAt: null };

		const started = withPlacedPart(reply, running);
		expect(started.parts).toEqual([
			{ type: "text", text: "Looking." },
			running,
			{ type: "text", text: " Found it." },
		]);

		const completed = withPlacedPart(started, call);
		expect(completed.parts).toEqual([
			{ type: "text", text: "Looking." },
			call,
			{ type: "text", text: " Found it." },
		]);
	});
});
