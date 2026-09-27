import type { ToolCallPart } from "@sugabots/contracts";
import { Conflict } from "@sugabots/contracts/http";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/lib/query.ts";
import { client } from "@/test-client.ts";
import { ToolApprovalCard } from "./ToolApprovalCard.tsx";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const agent = { name: "Linear Handler", color: "green" as const, face: "pill" as const };

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
				look={{ name: "Linear", presetId: "linear" }}
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
	it("asks what it would do and where, and allows it once", async () => {
		const approval = client.api.toolApprovals.decide;
		show({ team: "Platform" });

		const card = screen.getByRole("region", { name: "Approval needed: Update issue in Linear" });
		expect(within(card).queryByRole("checkbox")).toBeNull();
		fireEvent.click(within(card).getByRole("button", { name: "Allow" }));

		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].payload).toEqual({ decision: "allow_once" });
	});

	it("keeps the answer given once it is accepted, until the turn records it", async () => {
		const approval = client.api.toolApprovals.decide;
		show({ team: "Platform" });

		fireEvent.click(screen.getByRole("button", { name: "Allow" }));

		await waitFor(() => expect(approval).toHaveBeenCalled());
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Allow" }).hasAttribute("disabled")).toBe(true),
		);
		expect(screen.getByRole("button", { name: "Deny" }).hasAttribute("disabled")).toBe(true);
	});

	it("lets the answer be given again if sending it failed", async () => {
		const approval = client.api.toolApprovals.decide;
		approval.mockReturnValue(
			Effect.fail(new Conflict({ message: "That tool approval has already been decided" })),
		);
		show({ team: "Platform" });

		fireEvent.click(screen.getByRole("button", { name: "Allow" }));

		await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
		expect(screen.getByRole("button", { name: "Allow" }).hasAttribute("disabled")).toBe(false);
	});

	it("denies it", async () => {
		const approval = client.api.toolApprovals.decide;
		show({ team: "Platform" });

		fireEvent.click(screen.getByRole("button", { name: "Deny" }));

		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].payload).toEqual({ decision: "deny" });
	});

	it("lays out every field on request, structured values as fields of their own", () => {
		show({
			...Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`field${index + 1}`, "x"])),
			assignee: { id: "u_123", name: "Tim Holm" },
			subscribers: [{ id: "u_1" }, { id: "u_2" }],
		});

		fireEvent.click(screen.getByRole("button", { name: /View the full request/ }));

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

		fireEvent.click(screen.getByRole("button", { name: /View the full request/ }));
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Allow" }));

		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].payload).toEqual({ decision: "allow_once" });
	});
});
