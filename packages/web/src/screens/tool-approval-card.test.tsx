import type { ToolCallPart } from "@sugabots/contracts";
import { Conflict } from "@sugabots/contracts/http";
import { userText } from "@sugabots/errors";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/client.test-support.ts";
import { createQueryClient } from "@/lib/query.ts";
import { ToolApprovalCard } from "./ToolApprovalCard.tsx";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

const bot = {
	name: "Linear Handler",
	color: "green" as const,
	eyes: "pill" as const,
	shape: "circle" as const,
};

function asking(
	input: ToolCallPart["input"],
	approval: ToolCallPart["approval"] = {
		id: "approval-1",
		status: "pending",
		approvers: "chat",
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
		atOffset: 0,
		startedAt: "2026-09-18T09:00:00.000Z",
		finishedAt: null,
		approval,
	};
}

function show(call: ToolCallPart, canApprove = true, projectId?: string) {
	const queries = createQueryClient();
	const card = (shown: ToolCallPart) => (
		<QueryClientProvider client={queries}>
			<ToolApprovalCard
				call={shown}
				bot={bot}
				chatId="0199a3a0-0000-7000-8000-0000000000b2"
				canApprove={canApprove}
				projectId={projectId}
				connector={{ name: "Linear", markId: "linear" }}
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
	client.api.approvals.decide.mockReturnValue(Effect.undefined);
});

describe("an approval request", () => {
	it("says who wants to use what, shows the request, and allows it once", async () => {
		const approval = client.api.approvals.decide;
		show(asking({ team: "Platform" }));

		const card = screen.getByRole("region", { name: "Approval request: Update issue in Linear" });
		within(card).getByText("Linear Handler wants to use Linear");
		within(card).getByText("Platform");
		fireEvent.click(inCard(/^Allow/));

		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].payload).toEqual({
			approvalId: "approval-1",
			decision: "allow_once",
		});
	});

	it("allows the replacement request on the same tool call", async () => {
		const first = asking({ team: "Platform" });
		const { recorded } = show(first);
		fireEvent.click(inCard(/^Allow/));
		await waitFor(() => expect(inCard(/^Allow/).hasAttribute("disabled")).toBe(true));

		recorded(
			asking(
				{ team: "Operations" },
				{
					id: "approval-2",
					status: "pending",
					approvers: "chat",
					decidedByName: null,
					decidedAt: null,
				},
			),
		);
		expect(inCard(/^Allow/).hasAttribute("disabled")).toBe(false);
		expect(inCard(/^Deny/).hasAttribute("disabled")).toBe(false);
		fireEvent.click(inCard(/^Allow/));
		await waitFor(() =>
			expect(client.api.approvals.decide).toHaveBeenLastCalledWith(
				expect.objectContaining({
					params: { toolCallId: first.id },
					payload: { approvalId: "approval-2", decision: "allow_once" },
				}),
			),
		);
	});

	it.each([
		{
			canApprove: true,
			addressVisible: true,
			revision: 2,
			status: "pending",
			showsDestination: true,
		},
		{
			canApprove: false,
			addressVisible: true,
			revision: 2,
			status: "pending",
			showsDestination: false,
		},
		{
			canApprove: true,
			addressVisible: false,
			revision: 2,
			status: "pending",
			showsDestination: false,
		},
		{
			canApprove: true,
			addressVisible: true,
			revision: 3,
			status: "pending",
			showsDestination: false,
		},
		{
			canApprove: true,
			addressVisible: true,
			revision: 3,
			status: "allowed",
			showsDestination: false,
		},
	] as const)(
		"shows the recorded connector and respects destination access ($canApprove, $addressVisible, revision $revision, $status)",
		async ({ canApprove, addressVisible, revision, status, showsDestination }) => {
			const projectId = "0199a3a0-0000-7000-8000-000000000002";
			const connectorId = "0199a3a0-0000-7000-8000-000000000003";
			const url = "https://issues.example.com/mcp";
			client.api.connectors.list.mockReturnValue(
				Effect.succeed([
					{
						id: "0199a3a0-0000-7000-8000-000000000004",
						name: "Project Linear",
						enabled: false,
						restricted: true,
					},
				]),
			);
			client.api.connectors.listProjectBots.mockReturnValue(
				Effect.succeed([
					{
						id: connectorId,
						name: "Bot Linear",
						url: addressVisible ? url : null,
						kind: "mcp",
						addressRevision: 1,
						configurationRevision: revision,
						botId: "0199a3a0-0000-7000-8000-000000000005",
						on: true,
						addressChanged: false,
					},
				]),
			);
			show(
				asking(
					{ title: "Move the release" },
					{
						id: "approval-1",
						status,
						approvers: "chat",
						decidedByName: null,
						decidedAt: null,
						connector: { id: connectorId, revision: 2 },
					},
				),
				canApprove,
				projectId,
			);

			await screen.findByText("Linear Handler wants to use Bot Linear");
			expect(screen.queryByText(`Sends to ${url}`) !== null).toBe(showsDestination);
			expect(
				screen.queryByText(
					"This connector changed after Linear Handler asked. Choosing Allow closes this request and tells Linear Handler why. Ask Linear Handler to try again.",
				) !== null,
			).toBe(status === "pending" && revision !== 2);
		},
	);

	it("keeps the answer given until the turn records it, then announces it", async () => {
		const { recorded } = show(asking({ team: "Platform" }));

		fireEvent.click(inCard(/^Allow/));
		await waitFor(() => expect(inCard(/^Allow/).hasAttribute("disabled")).toBe(true));
		expect(inCard(/^Deny/).hasAttribute("disabled")).toBe(true);
		recorded({
			...asking(
				{ team: "Platform" },
				{
					id: "approval-1",
					status: "allowed",
					approvers: "chat",
					decidedByName: "You",
					decidedAt: "2026-09-18T09:01:00.000Z",
				},
			),
			status: "running",
		});

		expect(screen.getByRole("status").textContent).toContain("Allowed by You");
	});

	it("lets the answer be given again if sending it failed", async () => {
		const approval = client.api.approvals.decide;
		approval.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`That tool approval has already been decided` })),
		);
		show(asking({ team: "Platform" }));

		fireEvent.click(inCard(/^Allow/));

		await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
		expect(inCard(/^Allow/).hasAttribute("disabled")).toBe(false);
	});

	it("denies it", async () => {
		const approval = client.api.approvals.decide;
		show(asking({ team: "Platform" }));

		fireEvent.click(inCard(/^Deny/));

		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].payload).toEqual({
			approvalId: "approval-1",
			decision: "deny",
		});
	});

	it("lays out every field, structured values as fields of their own", () => {
		show(
			asking({
				...Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`field${index + 1}`, "x"])),
				assignee: { id: "u_123", name: "Theo Hart" },
				subscribers: [{ id: "u_1" }, { id: "u_2" }],
			}),
		);

		const card = screen.getByRole("region", { name: "Approval request: Update issue in Linear" });
		within(card).getByText("Field7");
		within(card).getByText("Name");
		within(card).getByText("Theo Hart");
		expect(within(card).getAllByRole("columnheader", { name: "Id" })).toHaveLength(1);
		expect(within(card).getAllByRole("row")).toHaveLength(3);
		expect(within(card).queryByText(/"name"/)).toBeNull();
	});

	it("opens the whole request full screen for review, and closes it once answered", async () => {
		const approval = client.api.approvals.decide;
		show(asking({ team: "Platform" }));

		fireEvent.click(screen.getByRole("button", { name: "Review" }));
		const request = await screen.findByRole("dialog", { name: "Update issue" });
		within(request).getByText(/"team": "Platform"/);
		fireEvent.click(within(request).getByRole("button", { name: /^Allow/ }));

		await waitFor(() => expect(approval).toHaveBeenCalled());
		expect(approval.mock.calls[0]?.[0].payload).toEqual({
			approvalId: "approval-1",
			decision: "allow_once",
		});
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("shows exact JSON when reviewing null and empty strings", async () => {
		const input = { before: { assignee: null }, after: { assignee: "" } };
		show(asking(input));

		fireEvent.click(screen.getByRole("button", { name: "Review" }));
		const request = await screen.findByRole("dialog", { name: "Update issue" });
		expect(request.querySelector("pre")?.textContent).toBe(JSON.stringify(input, null, 2));
	});

	it("closes the full-screen request without answering", async () => {
		show(asking({ team: "Platform" }));

		fireEvent.click(screen.getByRole("button", { name: "Review" }));
		const request = await screen.findByRole("dialog");
		fireEvent.click(within(request).getByRole("button", { name: "Close" }));

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(client.api.approvals.decide).not.toHaveBeenCalled();
	});

	it("says it waits on someone with permission when the reader cannot answer", () => {
		show(asking({ team: "Platform" }), false);

		screen.getByText("Waiting for someone with permission to answer this.");
		expect(screen.queryByRole("button", { name: /^Allow/ })).toBeNull();
	});

	it.each(["allowed", "denied"] as const)(
		"keeps the request readable once %s, and says who answered it without announcing it",
		(status) => {
			show(
				asking(
					{ team: "Platform" },
					{
						id: "approval-1",
						status,
						approvers: "chat",
						decidedByName: "Mia Chen",
						decidedAt: "2026-09-18T09:01:00.000Z",
					},
				),
			);

			const card = screen.getByRole("region", { name: "Approval request: Update issue in Linear" });
			within(card).getByText("Platform");
			expect(within(card).queryByRole("button", { name: /^(Allow|Deny)/ })).toBeNull();
			within(card).getByText(`${status === "allowed" ? "Allowed" : "Denied"} by Mia Chen`, {
				exact: false,
			});
			// An answer already in the history is read, not announced as it loads.
			expect(within(card).queryByRole("status")).toBeNull();
		},
	);
});
