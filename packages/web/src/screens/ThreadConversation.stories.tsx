import type {
	Message,
	MessagePart,
	SessionUser,
	ThreadParticipant,
	ToolCallPart,
} from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ComponentProps, useEffect, useState } from "react";
import { expect, screen, userEvent } from "storybook/test";
import preview from "#storybook/preview";
import { ThreadConversation } from "./ThreadConversation.tsx";

const host: Extract<ThreadParticipant, { kind: "agent" }> = {
	kind: "agent",
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Issue Triager",
	handle: "issue-triager",
	hue: 150,
	face: "smile",
};

const person: Extract<ThreadParticipant, { kind: "person" }> = {
	kind: "person",
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Sam Rivera",
	handle: "sam-rivera",
	image: null,
};

const user: SessionUser = {
	id: person.id,
	name: person.name,
	email: "sam.rivera@example.com",
	image: null,
};

function message(id: string, author: Message["author"], content: string): Message {
	return {
		id,
		threadId: "0199a3a0-0000-7000-8000-00000000000a",
		author,
		kind: "text",
		status: "complete",
		parts: [{ type: "text", text: content }],
		content,
		createdAt: "2026-09-22T04:30:00.000Z",
	};
}

const POD = "0199a3a0-0000-7000-8000-00000000000b";

function toolCall(id: string, tool: string): ToolCallPart {
	return {
		type: "tool_call",
		id,
		tool,
		input: {},
		output: { ok: true },
		status: "completed",
		error: null,
		mutating: false,
		atOffset: 0,
		startedAt: "2026-09-22T04:30:00.000Z",
		finishedAt: "2026-09-22T04:30:01.200Z",
	};
}

function reply(id: string, parts: MessagePart[]): Message {
	const content = parts.map((part) => (part.type === "text" ? part.text : "")).join("");
	return { ...message(id, host, content), parts };
}

const meta = preview.meta({
	title: "Product/ThreadConversation",
	component: ThreadConversation,
	args: {
		host,
		isRunning: false,
		mentionable: [host, person],
		user,
		podId: POD,
	},
	decorators: [
		function WithQueries(Story) {
			// The pod has no connections, so its tools are named without a mark.
			const [queryClient] = useState(() => {
				const client = new QueryClient();
				client.setQueryData(["connections", POD], []);
				return client;
			});
			useEffect(() => () => queryClient.clear(), [queryClient]);
			return (
				<QueryClientProvider client={queryClient}>
					<div className="mx-auto max-w-home py-4">
						<Story />
					</div>
				</QueryClientProvider>
			);
		},
	],
});

/** Hovering a message's time shows the full date and time, with the year for an earlier year. */
export const FullTimestampOnHover = meta.story({
	play: async ({ canvas }) => {
		await userEvent.hover(canvas.getByText(/\d:\d{2}/, { selector: "time" }));
		// Date order and clock style follow the browser's locale; the year and seconds are what matter.
		await expect(await screen.findByText(/2025 at \d{1,2}:\d{2}:46/)).toBeVisible();
	},
	args: {
		messages: [
			{
				...message("0199a3a0-0000-7000-8000-000000000106", person, "Is the release still on?"),
				createdAt: "2025-08-05T05:46:46.000Z",
			},
		],
	},
});

/** A fenced code block whose lines are far wider than the bubble. */
export const WideCodeBlock = meta.story({
	play: async ({ canvas }) => {
		const code = canvas.getByRole("region", { name: "Code block" });
		await expect(code.scrollWidth).toBeGreaterThan(code.clientWidth);
		code.focus();
		await expect(code).toHaveFocus();
	},
	args: {
		messages: [
			message("0199a3a0-0000-7000-8000-000000000101", person, "Why is the deploy failing?"),
			message(
				"0199a3a0-0000-7000-8000-000000000102",
				host,
				[
					"The provisioner rejects the stack because the role has no attached policy:",
					"",
					"```ts",
					'const provisioner = new StackProvisioner({ region: "ap-southeast-2", roleArn: "arn:aws:iam::123456789012:role/sugabots-deployment-role", retries: 3 });',
					"await provisioner.apply(stack);",
					"```",
					"",
					"Attach the policy and retry.",
				].join("\n"),
			),
		],
	},
});

/** A fence with no language on it, which is what a model writes most of the time. */
export const UnlabelledCodeBlock = meta.story({
	args: {
		messages: [
			message(
				"0199a3a0-0000-7000-8000-000000000105",
				host,
				[
					"The failing check is:",
					"",
					"```",
					"AccessDenied: User arn:aws:sts::123456789012:assumed-role/sugabots-deployment-role/deploy is not authorized to perform iam:PassRole",
					"```",
				].join("\n"),
			),
		],
	},
});

/** Tokens with nowhere to wrap: an inline code path, and a bare URL. */
export const UnbreakableWords = meta.story({
	play: async ({ canvas }) => {
		for (const spilling of [/209 events/, /Thanks/]) {
			const line = canvas.getByText(spilling);
			await expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
		}
	},
	args: {
		messages: [
			message(
				"0199a3a0-0000-7000-8000-000000000103",
				host,
				[
					"Two routes account for most of the traffic:",
					"",
					"* `/api/projects/[projectId]/environments/[environmentId]/events/[containerId]/stream` (209 events).",
					"* `/project/:projectId/env/:environmentId` (105 events).",
					"",
					"The full trace is at https://storage.example.com/traces/sugabots/2026-09-22/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/trace.json.",
				].join("\n"),
			),
			message(
				"0199a3a0-0000-7000-8000-000000000104",
				person,
				"Thanks — https://storage.example.com/traces/sugabots/2026-09-22/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/trace.json is the one I was missing.",
			),
		],
	},
});

/**
 * An agent that wrote a line before each tool call: the thread shows only its
 * answer, and what it said on the way is in the activity log.
 */
export const NarratedBetweenToolCalls = meta.story({
	play: async ({ canvas }) => {
		await expect(canvas.getAllByRole("article")).toHaveLength(2);
	},
	args: {
		messages: [
			message(
				"0199a3a0-0000-7000-8000-000000000106",
				person,
				"What's in the current cycle for Internal Agents?",
			),
			reply("0199a3a0-0000-7000-8000-000000000107", [
				{ type: "text", text: "Let me start by finding the current cycle for the Suga Eng team:" },
				toolCall("0199a3a0-0000-7000-8000-000000000201", "linear__get_team"),
				{ type: "text", text: "Now let me get the current cycle with the team ID:" },
				toolCall("0199a3a0-0000-7000-8000-000000000202", "linear__list_cycles"),
				{ type: "text", text: "The current cycle is Cycle 33. Now the issues in it:" },
				toolCall("0199a3a0-0000-7000-8000-000000000203", "linear__list_issues"),
				{
					type: "text",
					text: "There are two high-priority issues in Cycle 33: NIT-1846, on slow chat history loading, and NIT-1819, a layout shift when enabling a provider.",
				},
			]),
		],
	},
});

/** How long the looping reply below spends typing before it lands. */
const ARRIVING_TYPING_MS = 2_500;

const arrivingAnswer = [
	"There are two high-priority issues in Cycle 33:",
	"",
	"1. **NIT-1846** — Investigate and resolve slow initial chat history load time",
	"2. **NIT-1819** — Trying to enable a provider causes a layout shift and error",
	"",
	"Both are in progress.",
].join("\n");

/** Types for a moment, then lands, then starts again, so the arrival can be watched. */
function ArrivingReply(props: ComponentProps<typeof ThreadConversation>) {
	// Even ticks type, odd ticks land; each pair is a fresh reply.
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const next = setInterval(() => setTick((count) => count + 1), ARRIVING_TYPING_MS);
		return () => clearInterval(next);
	}, []);
	const round = Math.floor(tick / 2);
	const landed = tick % 2 === 1;
	const answer = reply(`0199a3a0-0000-7000-8000-0000000003${String(round).padStart(2, "0")}`, [
		{ type: "text", text: arrivingAnswer },
	]);
	return (
		<ThreadConversation
			{...props}
			messages={[
				message("0199a3a0-0000-7000-8000-000000000108", person, "What's in the current cycle?"),
				landed ? answer : { ...answer, status: "streaming", parts: [], content: "" },
			]}
		/>
	);
}

/** A reply landing while the thread is open: it grows out of the typing line and reveals its words. */
export const AReplyArriving = meta.story({
	args: { messages: [] },
	render: (args) => <ArrivingReply {...args} />,
});
