import type { ChatDetails } from "@sugabots/contracts";
import { growthDesk, revenue } from "@/shell/story-fixtures.test-support.ts";

export const CHAT = "0199a3a0-0000-7000-8000-000000000401";
export const RUN = "0199a3a0-0000-7000-8000-000000000403";
const runBot = {
	kind: "bot" as const,
	id: growthDesk.id,
	name: growthDesk.name,
	handle: growthDesk.handle,
	color: growthDesk.color,
	eyes: growthDesk.eyes,
	shape: growthDesk.shape,
};

/** An automation run a webhook started, which posted its result in the chat. */
export function automationRun(failed: boolean, rootChatId = CHAT): ChatDetails {
	return {
		chat: {
			id: RUN,
			workspaceId: revenue.workspaceId,
			projectId: revenue.id,
			botId: growthDesk.id,
			rootChatId,
			kind: "run",
			title: "Overnight outbound",
			working: false,
			resolvedAt: null,
			createdAt: "2026-09-18T06:00:00.000Z",
			updatedAt: "2026-09-18T06:02:00.000Z",
		},
		permissions: { approveToolCallsIn: [], approveComputerRequests: true, interruptTurns: [] },
		participants: [runBot],
		projectBots: [runBot],
		membersReachingProject: [],
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
		automationRun: {
			id: "0199a3a0-0000-7000-8000-000000000404",
			automationId: "0199a3a0-0000-7000-8000-000000000405",
			workspaceId: revenue.workspaceId,
			botId: growthDesk.id,
			chatId: RUN,
			rootChatId,
			automationName: "Overnight outbound",
			instructions: "Queue the overnight leads and draft replies to anyone who answered.",
			trigger: {
				kind: "webhook",
				receivedAt: "2026-09-18T06:00:00.000Z",
				idempotencyKey: "crm-2026-09-18",
				payload: { source: "crm", leads: 38 },
			},
			state: failed ? "failed" : "completed",
			error: failed ? "HubSpot did not answer within 30 seconds." : null,
			posted: !failed,
			acceptedAt: "2026-09-18T06:00:00.000Z",
			startedAt: "2026-09-18T06:00:01.000Z",
			finishedAt: "2026-09-18T06:02:00.000Z",
		},
		messages: failed
			? []
			: [
					{
						id: "0199a3a0-0000-7000-8000-000000000415",
						chatId: RUN,
						author: runBot,
						status: "complete",
						parts: [
							{
								type: "text",
								text: "Queued 38 leads. Six have replied; drafts are in the outbox.",
							},
						],
						content: "Queued 38 leads. Six have replied; drafts are in the outbox.",
						createdAt: "2026-09-18T06:02:00.000Z",
					},
				],
	};
}
