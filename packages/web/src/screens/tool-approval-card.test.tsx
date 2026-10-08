import type { ToolCallPart } from "@sugabots/contracts";
import { Conflict } from "@sugabots/contracts/http";
import { userText } from "@sugabots/errors";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/lib/query.ts";
import { client } from "@/test-client.ts";
import { ToolApprovalCard } from "./ToolApprovalCard.tsx";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const agent = { name: "Linear Handler", color: "green" as const, face: "pill" as const };

function asking(
	input: ToolCallPart["input"],
	approval: ToolCallPart["approval"] = {
		status: "pending",
		decidedByName: null,
		decidedAt: null,
	},
): ToolCallPart {
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
		approval,
	};
}

function show(call: ToolCallPart, canApprove = true) {
	const queries = createQueryClient();
	const card = (shown: ToolCallPart) => (
		<QueryClientProvider client={queries}>
			<ToolApprovalCard
				call={shown}
				agent={agent}
				threadId="0199a3a0-0000-7000-8000-0000000000b2"
				podId="0199a3a0-0000-7000-8000-0000000000b1"
				canApprove={canApprove}
				look={{ name: "Linear", presetId: "linear" }}
			/>
		</QueryClientProvider>
	);
	const { rerender } = render(card(call));
	return { recorded: (next: ToolCallPart) => rerender(card(next)) };
}

/** The card's answer as a wide screen shows it, in the card rather than the full-screen request. */
function inCard(name: RegExp) {
	const card = screen.getByRole("region", { name: "Approval request: Update issue in Linear" });
	return within(card).getByRole("button", { name });
}

beforeEach(() => {
	client.api.toolApprovals.decide.mockReturnValue(Effect.undefined);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("an approval request", () => {
	it("says who wants to use what, shows the request, and allows it once", async () => {
		const approval = client.api.toolApprovals.decide;
		show(asking({ team: "Platform" }));

		const card = screen.getByRole("region", { name: "Approval request: Update issue in Linear" });
		expect(within(card).getByText("Linear Handler wants to use Linear")).toBeDefined();
		expect(within(card).getByText("Platform")).toBeDefined();
		expect(within(card).queryByRole("checkbox")).toBeNull();
		fireEvent.click(inCard(/^Allow/));

		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].payload).toEqual({ decision: "allow_once" });
	});

	it("keeps the answer given once it is accepted, until the turn records it", async () => {
		const approval = client.api.toolApprovals.decide;
		show(asking({ team: "Platform" }));

		fireEvent.click(inCard(/^Allow/));

		await waitFor(() => expect(approval).toHaveBeenCalled());
		await waitFor(() => expect(inCard(/^Allow/).hasAttribute("disabled")).toBe(true));
		expect(inCard(/^Deny/).hasAttribute("disabled")).toBe(true);
	});

	it("announces the answer given here once the turn records it", async () => {
		const { recorded } = show(asking({ team: "Platform" }));

		fireEvent.click(inCard(/^Allow/));
		await waitFor(() => expect(inCard(/^Allow/).hasAttribute("disabled")).toBe(true));
		recorded({
			...asking(
				{ team: "Platform" },
				{ status: "allowed", decidedByName: "You", decidedAt: "2026-09-18T09:01:00.000Z" },
			),
			status: "running",
		});

		expect(screen.getByRole("status").textContent).toContain("Allowed by You");
	});

	it("lets the answer be given again if sending it failed", async () => {
		const approval = client.api.toolApprovals.decide;
		approval.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`That tool approval has already been decided` })),
		);
		show(asking({ team: "Platform" }));

		fireEvent.click(inCard(/^Allow/));

		await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
		expect(inCard(/^Allow/).hasAttribute("disabled")).toBe(false);
	});

	it("denies it", async () => {
		const approval = client.api.toolApprovals.decide;
		show(asking({ team: "Platform" }));

		fireEvent.click(inCard(/^Deny/));

		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].payload).toEqual({ decision: "deny" });
	});

	it("lays out every field, structured values as fields of their own", () => {
		show(
			asking({
				...Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`field${index + 1}`, "x"])),
				assignee: { id: "u_123", name: "Tim Holm" },
				subscribers: [{ id: "u_1" }, { id: "u_2" }],
			}),
		);

		const card = screen.getByRole("region", { name: "Approval request: Update issue in Linear" });
		expect(within(card).getByText("Field7")).toBeDefined();
		expect(within(card).getByText("Name")).toBeDefined();
		expect(within(card).getByText("Tim Holm")).toBeDefined();
		expect(within(card).getAllByRole("columnheader", { name: "Id" })).toHaveLength(1);
		expect(within(card).getAllByRole("row")).toHaveLength(3);
		expect(within(card).queryByText(/"name"/)).toBeNull();
	});

	it("opens the whole request full screen for review, and closes it once answered", async () => {
		const approval = client.api.toolApprovals.decide;
		show(asking({ team: "Platform" }));

		fireEvent.click(screen.getByRole("button", { name: "Review" }));
		const request = await screen.findByRole("dialog", { name: "Update issue" });
		expect(within(request).getByText("Platform")).toBeDefined();
		fireEvent.click(within(request).getByRole("button", { name: /^Allow/ }));

		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].payload).toEqual({ decision: "allow_once" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("closes the full-screen request without answering", async () => {
		show(asking({ team: "Platform" }));

		fireEvent.click(screen.getByRole("button", { name: "Review" }));
		const request = await screen.findByRole("dialog");
		fireEvent.click(within(request).getByRole("button", { name: "Close" }));

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(client.api.toolApprovals.decide).not.toHaveBeenCalled();
	});

	it("says it waits on someone with permission when the reader cannot answer", () => {
		show(asking({ team: "Platform" }), false);

		expect(screen.getByText("Waiting for someone with permission to answer this.")).toBeDefined();
		expect(screen.queryByRole("button", { name: /^Allow/ })).toBeNull();
	});

	it.each(["allowed", "denied"] as const)(
		"keeps the request readable once %s, and says who answered it without announcing it",
		(status) => {
			show(
				asking(
					{ team: "Platform" },
					{ status, decidedByName: "Mia Chen", decidedAt: "2026-09-18T09:01:00.000Z" },
				),
			);

			const card = screen.getByRole("region", { name: "Approval request: Update issue in Linear" });
			expect(within(card).getByText("Platform")).toBeDefined();
			expect(within(card).queryByRole("button", { name: /^(Allow|Deny)/ })).toBeNull();
			expect(
				within(card).getByText(`${status === "allowed" ? "Allowed" : "Denied"} by Mia Chen`, {
					exact: false,
				}),
			).toBeDefined();
			// An answer already in the history is read, not announced as it loads.
			expect(within(card).queryByRole("status")).toBeNull();
		},
	);
});
