import {
	botParticipantOf,
	type ChatHistoryEntry,
	type Message as ChatMessage,
	type ConversationDetails,
} from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, revenue } from "@/shell/story-fixtures.ts";
import {
	appHandlers,
	StoryApp,
	storyChatDetails,
	storyThreadFor,
	storyWorkspace,
} from "@/story-app.tsx";

/*
 * What Inbox opens beside its list: a message in its chat, jumped to and
 * pointed out, or an automation run as a page of its own. Neither is the chat's
 * own page, so there are no Details, and Open thread goes there.
 */

const API = import.meta.env.VITE_API_URL as string;

const chat = storyThreadFor(growthDesk);
const bot = botParticipantOf(growthDesk);

/** A chat long enough that a jump to an early message has somewhere to scroll. */
const messages: ChatMessage[] = Array.from({ length: 24 }, (_, index) => {
	const text =
		index === 3
			? "@rowan-ellis can you sign off the Acme quote before 5?"
			: `Update ${index + 1} on the Northwind accounts.`;
	return {
		id: `0199a3a0-0000-7000-8000-000000000a${String(index).padStart(2, "0")}`,
		conversationId: chat.id,
		author:
			index === 3
				? testPerson({ id: "0199a3a0-0000-7000-8000-000000000011", name: "Jay Yu" })
				: bot,
		kind: "text",
		status: "complete",
		parts: [{ type: "text", text }],
		content: text,
		createdAt: `2026-09-18T0${Math.floor(index / 10)}:${String((index % 10) * 5).padStart(2, "0")}:00.000Z`,
	};
});
const mention = messages[3] as ChatMessage;

const RUN = "0199a3a0-0000-7000-8000-000000000a90";
const EXECUTION = "0199a3a0-0000-7000-8000-000000000a91";
const AUTOMATION = "0199a3a0-0000-7000-8000-000000000a92";
const runEntry: ChatHistoryEntry = {
	conversationId: RUN,
	parentConversationId: null,
	kind: "run",
	title: "Overnight outbound",
	participants: [bot],
	status: "completed",
	automationRun: {
		runId: EXECUTION,
		automationId: AUTOMATION,
		automationName: "Overnight outbound",
		triggerKind: "routine",
	},
};
const run: ConversationDetails = {
	...storyChatDetails(growthDesk),
	conversation: {
		...storyChatDetails(growthDesk).conversation,
		id: RUN,
		kind: "run",
		title: "Overnight outbound",
	},
	participants: [bot],
	automationRun: {
		id: EXECUTION,
		automationId: AUTOMATION,
		workspaceId: revenue.workspaceId,
		botId: growthDesk.id,
		conversationId: RUN,
		rootConversationId: chat.id,
		automationName: "Overnight outbound",
		instructions: "Queue the overnight leads and draft replies to anyone who answered.",
		trigger: {
			kind: "routine",
			scheduledAt: "2026-09-18T06:00:00.000Z",
			acceptedAt: "2026-09-18T06:00:00.000Z",
		},
		state: "completed",
		error: null,
		posted: true,
		acceptedAt: "2026-09-18T06:00:00.000Z",
		startedAt: "2026-09-18T06:00:01.000Z",
		finishedAt: "2026-09-18T06:02:00.000Z",
	},
	messages: [
		{
			...(messages[0] as ChatMessage),
			id: "0199a3a0-0000-7000-8000-000000000a93",
			conversationId: RUN,
			parts: [
				{ type: "text", text: "Queued 38 leads. Six have replied; drafts are in the outbox." },
			],
			content: "Queued 38 leads. Six have replied; drafts are in the outbox.",
		},
	],
};

const meta = preview.meta({
	title: "Views/InboxPane",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(
			http.get(`${API}/conversations/${RUN}`, () => HttpResponse.json(run)),
			http.get(`${API}/conversations/:conversationId/history`, () =>
				HttpResponse.json({ items: [runEntry], nextCursor: null }),
			),
			...appHandlers({ messages: { [growthDesk.id]: messages } }),
		);
	},
});

const opened = (search: string) => `/${storyWorkspace.slug}/inbox/${chat.id}?${search}`;

/** A mention opened in its chat: the chat jumps to it, points it out, and puts the focus on it. */
export const MessageJumpedTo = meta.story({
	render: () => <StoryApp path={opened(`message=${mention.id}`)} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("link", { name: "Open thread" })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Details" })).toBeNull();
	},
});

/** An automation run opened as a page of its own, with Back to Inbox on a phone and Open thread. */
export const RunPage = meta.story({
	render: () => <StoryApp path={opened(`itemPage=${RUN}`)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Overnight outbound" }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("log", { name: "Chat messages" })).toBeNull();
		await expect(canvas.getByRole("link", { name: "Open thread" })).toBeInTheDocument();
	},
});
