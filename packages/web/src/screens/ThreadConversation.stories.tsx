import type {
	Message,
	MessagePart,
	SessionUser,
	ThreadParticipant,
	ToolCallPart,
} from "@sugabots/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ComponentProps, useEffect, useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { queuedBehindReply } from "./queued-messages.ts";
import { ThreadConversation } from "./ThreadConversation.tsx";

const host: Extract<ThreadParticipant, { kind: "agent" }> = {
	kind: "agent",
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Issue Triager",
	handle: "issue-triager",
	color: "green",
	face: "arc",
};

const person: Extract<ThreadParticipant, { kind: "person" }> = {
	kind: "person",
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Sam Rivera",
	handle: "sam-rivera",
	image: null,
};

const jay: Extract<ThreadParticipant, { kind: "person" }> = {
	kind: "person",
	id: "0199a3a0-0000-7000-8000-000000000003",
	name: "Jay Park",
	handle: "jay-park",
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
		participants: [host, person],
		user,
		podId: POD,
		onOpenCollaboration: fn(),
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
					<div className="mx-auto py-4">
						<Story />
					</div>
				</QueryClientProvider>
			);
		},
	],
});

/**
 * Hovering a bubble shows its time beside it (hover in the canvas to see it);
 * the full date and time, with the year, is its title.
 */
export const TimeOnHover = meta.story({
	play: async ({ canvas }) => {
		const time = canvas.getByText(/\d:\d{2}/, { selector: "time" });
		// Date order and clock style follow the browser's locale; the year and seconds are what matter.
		await expect(time.title).toMatch(/2025 at \d{1,2}:\d{2}:46/);
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

/**
 * Runs groups one author's messages: the name above the first bubble, the face
 * beside the last. Your own messages sit on the right in the accent, with no face.
 */
export const Runs = meta.story({
	args: {
		messages: [
			message(
				"0199a3a0-0000-7000-8000-000000000201",
				host,
				"Overnight outbound queued `38` leads and six have already replied.",
			),
			message(
				"0199a3a0-0000-7000-8000-000000000202",
				host,
				"The two Northwind accounts are in there, and both asked for pricing. Want me to draft replies?",
			),
			message(
				"0199a3a0-0000-7000-8000-000000000203",
				jay,
				"Yes please. Keep the tone short, they hate long emails.",
			),
			message(
				"0199a3a0-0000-7000-8000-000000000204",
				person,
				"Also, billing timeouts are back on checkout.",
			),
			message(
				"0199a3a0-0000-7000-8000-000000000205",
				person,
				"Can you check Sentry and get it tracked if nothing's open?",
			),
		],
	},
	play: async ({ canvas }) => {
		// Two bot bubbles in a row carry the name once and the face once.
		await expect(canvas.getAllByText("Issue Triager")).toHaveLength(1);
		await expect(canvas.getByText("Jay Park")).toBeInTheDocument();
		await expect(canvas.queryByText("Sam Rivera")).toBeNull();
	},
});

const writingMessages = [
	message(
		"0199a3a0-0000-7000-8000-000000000221",
		person,
		"Billing timeouts are back on checkout. Can you check Sentry?",
	),
	{
		...message("0199a3a0-0000-7000-8000-000000000222", host, ""),
		status: "streaming" as const,
		parts: [],
	},
	message(
		"0199a3a0-0000-7000-8000-000000000223",
		jay,
		"The Stripe webhook is failing too, might be the same thing.",
	),
	message("0199a3a0-0000-7000-8000-000000000224", jay, "Started around 9 this morning."),
	message("0199a3a0-0000-7000-8000-000000000225", person, "Track both if nothing's open."),
];

/**
 * Messages sent while the bot is still writing a reply wait for its next one,
 * which answers them together. Each person's run says so once, so nobody
 * wonders whether theirs was dropped.
 */
export const QueuedBehindAReply = meta.story({
	tags: ["ai-generated"],
	args: {
		participants: [host, person, jay],
		messages: writingMessages,
		queued: queuedBehindReply(writingMessages),
	},
	play: async ({ canvas }) => {
		await expect(canvas.getAllByRole("article", { name: "Jay Park, queued" })).toHaveLength(2);
		await expect(canvas.getByRole("article", { name: "Sam Rivera, queued" })).toBeInTheDocument();
		// The question the reply is answering is not waiting on anything.
		const sams = canvas.getAllByRole("article", { name: /^Sam Rivera, / });
		await expect(sams.filter((bubble) => !bubble.ariaLabel?.endsWith("queued"))).toHaveLength(1);
		// Once for each person's run, under its last bubble.
		const shown = canvas
			.getAllByText("Queued")
			.filter((note) => note.checkVisibility({ visibilityProperty: true }));
		await expect(shown).toHaveLength(2);
	},
});

/** How long the loop below stays on each state: writing, then landed. */
const HAND_OFF_MS = 3_000;

/** The reply the queued messages waited behind has landed, and the next one has started. */
const handedOffMessages = [
	...writingMessages.slice(0, 1),
	message(
		"0199a3a0-0000-7000-8000-000000000222",
		host,
		"Checkout timeouts are tracked as NIT-1902.",
	),
	...writingMessages.slice(2),
	{
		...message("0199a3a0-0000-7000-8000-000000000226", host, ""),
		status: "streaming" as const,
		parts: [],
	},
];

/** Waits behind a reply, then sees it land and the next one start, over and over. */
function HandingOff(props: ComponentProps<typeof ThreadConversation>) {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const next = setInterval(() => setTick((count) => count + 1), HAND_OFF_MS);
		return () => clearInterval(next);
	}, []);
	const messages = tick % 2 === 1 ? handedOffMessages : writingMessages;
	return <ThreadConversation {...props} messages={messages} queued={queuedBehindReply(messages)} />;
}

/** The bot takes the queued messages up: their notes fold away as it starts its next reply. */
export const QueueHandOff = meta.story({
	tags: ["ai-generated"],
	args: { participants: [host, person, jay], messages: [] },
	render: (args) => <HandingOff {...args} />,
});

/** A new day in the middle of a thread gets room above its separator, so it reads as a new stretch. */
export const ANewDay = meta.story({
	args: {
		messages: [
			message(
				"0199a3a0-0000-7000-8000-000000000211",
				host,
				"Drafted both. They're in your outbox.",
			),
			{
				...message("0199a3a0-0000-7000-8000-000000000212", person, "Did either of them reply?"),
				createdAt: "2026-09-23T09:12:00.000Z",
			},
		],
	},
	play: async ({ canvas }) => {
		const separators = canvas.getAllByText(/\d:\d\d$/, { selector: "p" });
		await expect(separators).toHaveLength(2);
	},
});

const other: Extract<ThreadParticipant, { kind: "agent" }> = {
	kind: "agent",
	id: "0199a3a0-0000-7000-8000-000000000007",
	name: "Linear Handler",
	handle: "linear-handler",
	color: "orange",
	face: "dot",
};

/**
 * Mirrored is a collaboration as its sidebar shows it: the chat's bot on the
 * right, the bot it asked on the left, smaller faces and bubbles, and no names.
 */
export const Mirrored = meta.story({
	args: {
		rightAgentId: host.id,
		compact: true,
		participants: [host, other],
		messages: [
			message(
				"0199a3a0-0000-7000-8000-000000000301",
				host,
				"Ryan is seeing billing timeouts on checkout. Can you check Sentry and open an issue if nothing's tracked?",
			),
			message(
				"0199a3a0-0000-7000-8000-000000000302",
				other,
				"41 events in 24h, all on `POST /checkout`, hitting the 30s gateway limit.",
			),
			message(
				"0199a3a0-0000-7000-8000-000000000303",
				other,
				"Nothing open in Linear. I'd like to create one.",
			),
		],
	},
	decorators: [
		(Story) => (
			<div className="w-[360px] px-3.5">
				<Story />
			</div>
		),
	],
	play: async ({ canvas }) => {
		await expect(canvas.queryByText("Linear Handler")).toBeNull();
	},
});

/**
 * Failures in a collaboration's sidebar: the note under each bubble lines up with
 * the bubble, clear of the smaller face, on whichever side the face is.
 */
export const FailedInTheSidebar = meta.story({
	tags: ["ai-generated"],
	args: {
		rightAgentId: host.id,
		compact: true,
		participants: [host, other],
		messages: [
			message(
				"0199a3a0-0000-7000-8000-000000000231",
				host,
				"Can you check whether the Stripe webhook is failing?",
			),
			{
				...message("0199a3a0-0000-7000-8000-000000000232", other, "Checking the Stripe dashboard."),
				status: "failed",
				error: "The model provider did not answer.",
			},
			{
				...message(
					"0199a3a0-0000-7000-8000-000000000233",
					host,
					"Never mind, I'll open it myself.",
				),
				status: "cancelled",
			},
		],
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Reply failed.")).toBeInTheDocument();
		await expect(canvas.getByText("Reply stopped")).toBeInTheDocument();
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

/** SomeoneTyping is another person writing in the composer after the thread's last message. */
export const SomeoneTyping = meta.story({
	args: {
		participants: [host, person, jay],
		messages: [
			message(
				"0199a3a0-0000-7000-8000-000000000601",
				host,
				"Checkout timeouts are tracked as BILL-212, and Jay is on call.",
			),
		],
		peopleTyping: [jay],
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("status", { name: "Jay Park is typing" })).toBeVisible();
	},
});

/** TypingWithTheBot is a person typing while the bot writes its reply: both faces share one line. */
export const TypingWithTheBot = meta.story({
	args: {
		participants: [host, person, jay],
		messages: [
			message("0199a3a0-0000-7000-8000-000000000701", person, "Is checkout still timing out?"),
			{
				...message("0199a3a0-0000-7000-8000-000000000702", host, ""),
				status: "streaming",
				parts: [],
			},
		],
		peopleTyping: [jay],
	},
	play: async ({ canvas }) => {
		await expect(
			canvas.getByRole("status", { name: "Issue Triager and Jay Park are typing" }),
		).toBeVisible();
		await expect(canvas.getAllByRole("status")).toHaveLength(1);
	},
});

/**
 * A mention names someone in their own colours: a bot on its tint, a person on
 * a neutral chip, in your bubbles, other people's and a bot's markdown alike.
 * Linear Handler has not joined; it is named from the pod's crew. A handle in
 * code, one that names nobody, and an email address stay plain text.
 */
export const Mentions = meta.story({
	tags: ["ai-generated"],
	args: {
		participants: [host, person, jay, other],
		messages: [
			message(
				"0199a3a0-0000-7000-8000-000000000401",
				person,
				"@linear-handler is checkout on the board? cc @jay-park",
			),
			message(
				"0199a3a0-0000-7000-8000-000000000402",
				jay,
				"Asking @issue-triager too, and mailing jay@example.com and @nobody.",
			),
			message(
				"0199a3a0-0000-7000-8000-000000000403",
				host,
				"I asked **@linear-handler**: checkout timeouts are on the board.\n\n- @sam-rivera owns it\n- `@issue-triager` in code is only a handle\n- ~~the retry fix~~ did not hold",
			),
		],
	},
	play: async ({ canvas }) => {
		await expect(canvas.getAllByText("@linear-handler", { selector: "span" })).toHaveLength(2);
		await expect(canvas.getByText("@sam-rivera", { selector: "span" })).toBeInTheDocument();
		await expect(canvas.getByText("@issue-triager", { selector: "code" })).toBeInTheDocument();
		// Mentions add to Streamdown's markdown rather than replacing it.
		await expect(canvas.getByText("the retry fix", { selector: "del" })).toBeInTheDocument();
		await expect(canvas.getByText(/jay@example\.com and @nobody\./)).toBeInTheDocument();
	},
});
