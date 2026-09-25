import type { ToolCallPart } from "@sugabots/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/lib/query.ts";
import { client } from "@/test-client.ts";
import { DeniedToolLine, ToolApprovalCard } from "./ToolApprovalCard.tsx";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const agent = { name: "Linear Handler", hue: 158, face: "bar" as const };

function asking(input: ToolCallPart["input"]): ToolCallPart {
	return {
		type: "tool_call",
		id: "0199a3a0-0000-7000-8000-000000000001",
		tool: "linear__update_issue",
		input,
		output: null,
		status: "awaiting_approval",
		error: null,
		mutating: true,
		atOffset: 0,
		startedAt: "2026-09-18T09:00:00.000Z",
		finishedAt: null,
		approval: { status: "pending", decidedByName: null, decidedAt: null },
	};
}

function show(input: ToolCallPart["input"]) {
	render(
		<QueryClientProvider client={createQueryClient()}>
			<ToolApprovalCard
				call={asking(input)}
				agent={agent}
				threadId="0199a3a0-0000-7000-8000-0000000000b2"
				podId="0199a3a0-0000-7000-8000-0000000000b1"
				canApprove
				canAlwaysAllow={false}
				look={{ name: "Linear", presetId: "linear", hue: 262 }}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	client.api.toolApprovals.decide.mockReturnValue(Effect.undefined);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("an approval request", () => {
	it("shows a few of its fields, named in words, and counts the rest", () => {
		show(Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`field${index + 1}`, "x"])));

		expect(screen.getByText("Field1")).toBeDefined();
		expect(screen.getByText("Field6")).toBeDefined();
		expect(screen.queryByText("Field7")).toBeNull();
		expect(screen.getByText("3 more fields")).toBeDefined();
	});

	it("says a structured value by what it holds, and a plain list as its items", () => {
		show({
			dueDate: "2026-10-02",
			labels: ["performance", "chat"],
			assignee: { id: "u_123", name: "Tim Holm" },
			subscribers: [{ id: "u_1" }, { id: "u_2" }, { id: "u_3" }],
		});

		expect(screen.getByText("Due date")).toBeDefined();
		expect(screen.getByText("performance, chat")).toBeDefined();
		expect(screen.getByText("2 fields")).toBeDefined();
		expect(screen.getByText("3 items")).toBeDefined();
		expect(screen.queryByText(/Tim Holm/)).toBeNull();
	});

	it("previews the first few entries of a list, and counts the rest", () => {
		show(Array.from({ length: 60 }, (_, index) => ({ title: `Issue ${index}`, state: "todo" })));

		expect(screen.getByRole("columnheader", { name: "Title" })).toBeDefined();
		expect(screen.getByText("Issue 2")).toBeDefined();
		expect(screen.queryByText("Issue 3")).toBeNull();
		expect(screen.getByText("57 more")).toBeDefined();
	});

	it("lays out every field on request, structured values as fields of their own", () => {
		show({
			...Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`field${index + 1}`, "x"])),
			assignee: { id: "u_123", name: "Tim Holm" },
			subscribers: [{ id: "u_1" }, { id: "u_2" }],
		});

		fireEvent.click(screen.getByRole("button", { name: "View full request" }));

		const request = screen.getByRole("dialog", { name: "Update issue" });
		expect(within(request).getByText("Field7")).toBeDefined();
		expect(within(request).getByText("Name")).toBeDefined();
		expect(within(request).getByText("Tim Holm")).toBeDefined();
		expect(within(request).getAllByRole("columnheader", { name: "Id" })).toHaveLength(1);
		expect(within(request).getAllByRole("row")).toHaveLength(3);
		expect(within(request).queryByText(/"name"/)).toBeNull();
	});

	it("can be answered from the full request", async () => {
		const approval = client.api.toolApprovals.decide;
		show({ team: "Platform" });

		fireEvent.click(screen.getByRole("button", { name: "View full request" }));
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));

		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].payload).toEqual({ decision: "allow_once" });
	});
});

describe("a refused request", () => {
	it("shows on review what was refused and who refused it, with no way to answer again", () => {
		render(
			<QueryClientProvider client={createQueryClient()}>
				<DeniedToolLine
					call={{
						...asking({ team: "Platform", body: "Looks like the gateway limit." }),
						approval: { status: "denied", decidedByName: "Ryan Eyes", decidedAt: null },
					}}
					agent={agent}
					look={{ name: "Linear", presetId: "linear", hue: 262 }}
				/>
			</QueryClientProvider>,
		);
		expect(screen.getByText(/Ryan Eyes denied/)).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Review" }));

		const request = screen.getByRole("dialog", { name: "Update issue" });
		expect(within(request).getByText("Platform")).toBeDefined();
		expect(within(request).getByText("Looks like the gateway limit.")).toBeDefined();
		expect(within(request).getByText("Denied by Ryan Eyes")).toBeDefined();
		expect(within(request).queryByRole("button", { name: "Approve" })).toBeNull();
	});
});
