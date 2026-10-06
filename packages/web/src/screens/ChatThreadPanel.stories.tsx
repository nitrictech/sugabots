import type { Message, SessionUser, ThreadDetails } from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, linearHandler, revenue } from "@/shell/story-fixtures.ts";
import { ChatThreadPanel } from "./ChatThreadPanel.tsx";

const CHAT = "0199a3a0-0000-7000-8000-000000000401";
const THREAD = "0199a3a0-0000-7000-8000-000000000402";
const user = {
	id: "0199a3a0-0000-7000-8000-000000000009",
	name: "Ryan Eyes",
	email: "ryan@nitric.io",
};

const asker = {
	kind: "agent" as const,
	id: growthDesk.id,
	name: growthDesk.name,
	handle: growthDesk.handle,
	color: growthDesk.color,
	face: growthDesk.face,
};
const answerer = {
	kind: "agent" as const,
	id: linearHandler.id,
	name: linearHandler.name,
	handle: linearHandler.handle,
	color: linearHandler.color,
	face: linearHandler.face,
};

function message(
	id: string,
	author: typeof asker,
	text: string,
	before: Message["parts"] = [],
): Message {
	return {
		id: `0199a3a0-0000-7000-8000-00000000041${id}`,
		threadId: THREAD,
		author,
		kind: "text",
		status: "complete",
		parts: [...before, { type: "text", text }],
		content: text,
		createdAt: "2026-09-18T06:04:00.000Z",
	};
}

const collaboration: ThreadDetails = {
	thread: {
		id: THREAD,
		workspaceId: revenue.workspaceId,
		podId: revenue.id,
		hostAgentId: linearHandler.id,
		chatId: CHAT,
		type: "collaboration",
		title: "Checkout timeouts",
		status: "running",
		parentThreadId: null,
		initiatorUserId: user.id,
		createdAt: "2026-09-18T06:04:00.000Z",
		updatedAt: "2026-09-18T06:05:00.000Z",
	},
	capabilities: { approveToolCalls: true },
	routineExecution: null,
	participants: [answerer, asker],
	crew: [asker, answerer],
	members: [],
	olderMessagesCursor: null,
	queuedSince: null,
	reads: [],
	messages: [
		message(
			"1",
			asker,
			"Ryan is seeing checkout timeouts. Check Sentry and open an issue if nothing's tracked?",
		),
		message(
			"2",
			answerer,
			"41 events in 24h, all hitting the 30s gateway limit. Nothing open in Linear.",
			[
				{
					type: "tool_call",
					id: "0199a3a0-0000-7000-8000-000000000420",
					tool: "linear__create_issue",
					input: { title: "Checkout requests time out" },
					output: null,
					status: "awaiting_approval",
					error: null,
					mutating: true,
					atOffset: 0,
					startedAt: "2026-09-18T06:05:00.000Z",
					finishedAt: null,
					approval: { status: "pending", decidedByName: null, decidedAt: null },
				},
			],
		),
	],
};

const RUN = "0199a3a0-0000-7000-8000-000000000403";

/** A routine run a webhook started, which posted its result in the chat. */
function routineRun(failed: boolean): ThreadDetails {
	return {
		...collaboration,
		thread: {
			...collaboration.thread,
			id: RUN,
			hostAgentId: growthDesk.id,
			type: "routine",
			title: "Overnight outbound",
			status: "done",
		},
		participants: [asker],
		crew: [asker],
		routineExecution: {
			id: "0199a3a0-0000-7000-8000-000000000404",
			routineId: "0199a3a0-0000-7000-8000-000000000405",
			workspaceId: revenue.workspaceId,
			agentId: growthDesk.id,
			threadId: RUN,
			routineName: "Overnight outbound",
			instructions: "Queue the overnight leads and draft replies to anyone who answered.",
			trigger: {
				kind: "webhook",
				receivedAt: "2026-09-18T06:00:00.000Z",
				idempotencyKey: "crm-2026-09-18",
				payload: { source: "crm", leads: 38 },
			},
			state: failed ? "failed" : "completed",
			error: failed ? "HubSpot did not answer within 30 seconds." : null,
			acceptedAt: "2026-09-18T06:00:00.000Z",
			startedAt: "2026-09-18T06:00:01.000Z",
			finishedAt: "2026-09-18T06:02:00.000Z",
		},
		messages: failed
			? []
			: [message("5", asker, "Queued 38 leads. Six have replied; drafts are in the outbox.")],
	};
}

function Preview({ children, run }: { children: React.ReactNode; run?: ThreadDetails }) {
	const [queryClient] = useState(() => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(["thread", THREAD], collaboration);
		if (run) client.setQueryData(["thread", RUN], run);
		client.setQueryData(["connections", revenue.id], []);
		// The run's link to its routine is found through the bot's pod.
		client.setQueryData(
			["workspaces"],
			[{ id: revenue.workspaceId, name: "Nitric", slug: "nitric", timeZone: "UTC" }],
		);
		client.setQueryData(["pods", revenue.workspaceId], [revenue]);
		client.setQueryData(["agents", revenue.workspaceId], [growthDesk, linearHandler]);
		return client;
	});
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const meta = preview.meta({
	title: "Product/ChatThreadPanel",
	component: ChatThreadPanel,
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	args: {
		chatId: CHAT,
		chatAgentId: growthDesk.id,
		threadId: THREAD,
		history: [],
		user: user as SessionUser,
		onClose: fn(),
		onOpenThread: fn(),
	},
	render: (args) => (
		<Preview>
			<div className="relative flex h-screen justify-end bg-background">
				<ChatThreadPanel {...args} />
			</div>
		</Preview>
	),
});

/**
 * A collaboration waiting on an approval. Beside the chat on a wide screen,
 * answered on its card; on a phone a sheet whose card opens the request full
 * screen to answer it.
 */
export const WaitingOnApproval = meta.story({
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Collaboration" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: /^Allow/ })).toBeInTheDocument();
	},
});

/** A routine run a webhook started: its name, what it posted, and the payload behind the braces. */
export const RoutineRun = meta.story({
	args: { threadId: RUN },
	render: (args) => (
		<Preview run={routineRun(false)}>
			<div className="relative flex h-screen justify-end bg-background">
				<ChatThreadPanel {...args} />
			</div>
		</Preview>
	),
	play: async ({ canvas, userEvent }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Overnight outbound" }),
		).toBeInTheDocument();
		await userEvent.click(canvas.getByLabelText("View webhook payload"));
		await expect(canvas.getByText(/crm-2026-09-18/)).toBeInTheDocument();
	},
});

/** A run that failed says why, above what it managed. */
export const FailedRoutineRun = meta.story({
	args: { threadId: RUN },
	render: (args) => (
		<Preview run={routineRun(true)}>
			<div className="relative flex h-screen justify-end bg-background">
				<ChatThreadPanel {...args} />
			</div>
		</Preview>
	),
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("alert")).toHaveTextContent("HubSpot did not answer");
	},
});
