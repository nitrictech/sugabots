import type { Message, ThreadDetails } from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, userEvent, within } from "storybook/test";
import preview from "#storybook/preview";
import { chief, growthDesk, linearHandler, revenue } from "@/shell/story-fixtures.ts";
import {
	appHandlers,
	chatPath,
	StoryApp,
	storyChatFor,
	storyUser,
	storyWorkspace,
} from "../story-app.tsx";

/*
 * A bot's chat as the app shows it: the rail and the pod's list beside it, the
 * header across the top, and the thread with its composer. On a phone the chat
 * takes the screen, its header centred, with Back to the list.
 */

function said(id: string, by: "you" | "bot", text: string, at: string): Message {
	const thread = storyChatFor(growthDesk).mainThreadId;
	return {
		id: `0199a3a0-0000-7000-8000-0000000005${id}`,
		threadId: thread,
		author:
			by === "you"
				? {
						kind: "person",
						id: storyUser.id,
						name: storyUser.name,
						handle: "ryan-eyes",
						image: null,
					}
				: {
						kind: "agent",
						id: growthDesk.id,
						name: growthDesk.name,
						handle: growthDesk.handle,
						color: growthDesk.color,
						face: growthDesk.face,
					},
		kind: "text",
		status: "complete",
		parts: [{ type: "text", text }],
		content: text,
		createdAt: at,
	};
}

const conversation: Message[] = [
	said(
		"01",
		"bot",
		"Overnight outbound queued 38 leads and six have already replied.",
		"2026-09-18T06:04:00.000Z",
	),
	said(
		"02",
		"bot",
		"The two Northwind accounts both asked for pricing. Want me to draft replies?",
		"2026-09-18T06:04:30.000Z",
	),
	said("03", "you", "Yes please. Keep them short.", "2026-09-18T06:06:00.000Z"),
	said(
		"04",
		"bot",
		"Drafted both. They're in your outbox for a last look.",
		"2026-09-18T06:07:00.000Z",
	),
];

const meta = preview.meta({
	title: "Views/Chat",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...appHandlers({ messages: { [growthDesk.id]: conversation } }));
	},
	render: () => <StoryApp path={chatPath(growthDesk)} />,
});

/** The chat beside its pod's list, with Details a tap on the header away. */
export const Conversation = meta.story({
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" }, { timeout: 10_000 });
		await expect(await within(log).findByText(/Drafted both/)).toBeInTheDocument();
		await expect(canvas.getByRole("heading", { name: growthDesk.name })).toBeInTheDocument();
	},
});

/** A pod opened from the rail opens the chat at the top of its list. */
export const PodOpensTopChat = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: growthDesk.name }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("link", { name: new RegExp(growthDesk.name) })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/** On a phone the pod's list is the page, so it stays open on the list. */
export const PodOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	render: () => <StoryApp path={`/${storyWorkspace.slug}/pods/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: new RegExp(growthDesk.name) }, { timeout: 10_000 }),
		).toBeVisible();
		await expect(canvas.queryByRole("log", { name: "Chat messages" })).toBeNull();
	},
});

/** A bot nobody has written to yet: its face, and Say hello. */
export const FirstMessage = meta.story({
	render: () => <StoryApp path={chatPath(chief)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(`Say hello to ${chief.name}`, {}, { timeout: 10_000 }),
		).toBeInTheDocument();
	},
});

/** On a phone: the chat alone, its header centred, and Back to the pod's list. */
export const Phone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: "Back to Revenue" }, { timeout: 10_000 }),
		).toBeInTheDocument();
	},
});

/** Details open beside the chat: the bot's card, summary, who has written and what it can use. */
export const Details = meta.story({
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Details" }, { timeout: 10_000 }),
		);
		await expect(await canvas.findByRole("complementary", { name: "Details" })).toBeInTheDocument();
	},
});

/** On a phone, tapping the bot's name opens Details over the whole screen, header and all. */
export const DetailsOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: growthDesk.name }, { timeout: 10_000 }),
		);
		await expect(await canvas.findByRole("complementary", { name: "Details" })).toBeInTheDocument();
	},
});

/** On a tablet there is no room beside the chat, so Details slides over it from the right. */
export const DetailsOnATablet = meta.story({
	globals: { viewport: { value: "ipad11p", isRotated: false } },
	play: async ({ canvas }) => {
		await userEvent.click(
			await canvas.findByRole("button", { name: "Details" }, { timeout: 10_000 }),
		);
		await expect(await canvas.findByRole("complementary", { name: "Details" })).toBeInTheDocument();
		await expect(canvas.getByRole("log", { name: "Chat messages" })).toBeInTheDocument();
	},
});

const API = import.meta.env.VITE_API_URL as string;
const collaborationId = "0199a3a0-0000-7000-8000-000000000591";

const asker = {
	kind: "agent" as const,
	id: growthDesk.id,
	name: growthDesk.name,
	handle: growthDesk.handle,
	color: growthDesk.color,
	face: growthDesk.face,
};
const asked = {
	kind: "agent" as const,
	id: linearHandler.id,
	name: linearHandler.name,
	handle: linearHandler.handle,
	color: linearHandler.color,
	face: linearHandler.face,
};

/** Growth Desk asks Linear Handler, and its line in the chat opens the collaboration. */
const withCollaboration: Message[] = [
	said(
		"11",
		"you",
		"Checkout is timing out for some customers. Can you look?",
		"2026-09-18T06:02:00.000Z",
	),
	{
		...said("12", "bot", "Asking Linear Handler to check Sentry.", "2026-09-18T06:03:00.000Z"),
		parts: [
			{ type: "text", text: "Asking Linear Handler to check Sentry." },
			{
				type: "collaboration",
				id: "0199a3a0-0000-7000-8000-000000000592",
				agentId: linearHandler.id,
				agentName: linearHandler.name,
				threadId: collaborationId,
				brief: "Check Sentry and open an issue if nothing is tracked",
				status: "answered",
				answer: "41 events in 24h, all hitting the 30s gateway limit. I opened LIN-482.",
				atOffset: 38,
			},
		],
	},
];

function collabMessage(id: string, author: typeof asker, text: string, at: string): Message {
	return {
		id: `0199a3a0-0000-7000-8000-0000000005${id}`,
		threadId: collaborationId,
		author,
		kind: "text",
		status: "complete",
		parts: [{ type: "text", text }],
		content: text,
		createdAt: at,
	};
}

const collaboration: ThreadDetails = {
	thread: {
		id: collaborationId,
		workspaceId: growthDesk.workspaceId,
		podId: growthDesk.podId,
		hostAgentId: linearHandler.id,
		chatId: storyChatFor(growthDesk).id,
		type: "collaboration",
		title: "Check Sentry and open an issue if nothing is tracked",
		status: "done",
		parentThreadId: storyChatFor(growthDesk).mainThreadId,
		initiatorUserId: storyUser.id,
		createdAt: "2026-09-18T06:03:00.000Z",
		updatedAt: "2026-09-18T06:05:00.000Z",
	},
	capabilities: { approveToolCalls: true },
	routineExecution: null,
	participants: [asked, asker],
	crew: [asker, asked],
	olderMessagesCursor: null,
	messages: [
		collabMessage(
			"93",
			asker,
			"Ryan is seeing checkout timeouts. Check Sentry and open an issue if nothing's tracked?",
			"2026-09-18T06:03:00.000Z",
		),
		collabMessage(
			"94",
			asked,
			"41 events in 24h, all hitting the 30s gateway limit. Nothing was open, so I opened LIN-482.",
			"2026-09-18T06:05:00.000Z",
		),
	],
};

const collaborationHandlers = [
	http.get(`${API}/threads/${collaborationId}`, () => HttpResponse.json(collaboration)),
	...appHandlers({ messages: { [growthDesk.id]: withCollaboration } }),
];

/** A collaboration opened from its line: the sidebar with the two bots' thread, the chat's own on the right. */
export const Collaboration = meta.story({
	beforeEach({ msw }) {
		msw.use(...collaborationHandlers);
	},
	render: () => <StoryApp path={`${chatPath(growthDesk)}?thread=${collaborationId}`} />,
	play: async ({ canvas }) => {
		const panel = await canvas.findByRole(
			"complementary",
			{ name: collaboration.thread.title },
			{ timeout: 10_000 },
		);
		await expect(within(panel).getByText(`with ${linearHandler.name}`)).toBeInTheDocument();
	},
});

/** The same on a phone: a sheet risen over the dimmed chat. */
export const CollaborationOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	beforeEach({ msw }) {
		msw.use(...collaborationHandlers);
	},
	render: () => <StoryApp path={`${chatPath(growthDesk)}?thread=${collaborationId}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole(
				"complementary",
				{ name: collaboration.thread.title },
				{ timeout: 10_000 },
			),
		).toBeInTheDocument();
	},
});
