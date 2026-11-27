import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, revenue } from "@/shell/story-fixtures.test-support.ts";
import {
	appHandlers,
	chatPath,
	StoryApp,
	storyChatFor,
	storyMessage,
	storyProjectChatFor,
	storyWorkspace,
} from "@/story-app.test-support.tsx";

/*
 * A chat as it opens: its header, its messages and the composer at its foot,
 * in a bot's own chats or a project's.
 */

const chatId = storyChatFor(growthDesk).id;
const messagesInChat = [
	storyMessage({
		id: "a1",
		chatId,
		by: growthDesk,
		text: "Six of last night's leads replied. Two asked for pricing.",
		at: "2026-09-18T06:04:00.000Z",
	}),
	storyMessage({
		id: "a2",
		chatId,
		by: "you",
		text: "Draft replies to both, and keep them short.",
		at: "2026-09-18T06:06:00.000Z",
	}),
	storyMessage({
		id: "a3",
		chatId,
		by: growthDesk,
		text: "Drafted both. They're ready for a last look.",
		at: "2026-09-18T06:07:00.000Z",
	}),
];

const meta = preview.meta({
	title: "Product/Chat Pane",
	parameters: { layout: "fullscreen" },
});

/** BotChat is a chat with one bot, its messages in order above the composer. */
export const BotChat = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers({ messages: { [growthDesk.id]: messagesInChat } }));
	},
	render: () => <StoryApp path={chatPath(growthDesk)} />,
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		await expect(
			await within(log).findByText("Drafted both. They're ready for a last look."),
		).toBeInTheDocument();
		await expect(canvas.getByRole("textbox", { name: /^Message / })).toBeVisible();
	},
});

/** EmptyBotChat is a chat nobody has written in yet: the composer waits for the first message. */
export const EmptyBotChat = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers());
	},
	render: () => <StoryApp path={chatPath(growthDesk)} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("textbox", { name: /^Message / })).toBeVisible();
	},
});

/** ProjectChat is one of a project's chats, where the project's members and bots talk. */
export const ProjectChat = meta.story({
	beforeEach({ msw }) {
		msw.use(...appHandlers());
	},
	render: () => (
		<StoryApp
			path={`/${storyWorkspace.slug}/projects/${revenue.slug}/${storyProjectChatFor(revenue).id}`}
		/>
	),
	play: async ({ canvas }) => {
		const title = storyProjectChatFor(revenue).title;
		await expect(await canvas.findByRole("heading", { name: title, level: 1 })).toBeVisible();
		await expect(canvas.getByRole("textbox", { name: /^Message / })).toBeVisible();
	},
});

/** OnAPhone is the same chat taking the screen, under a compact header with Back. */
export const OnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	beforeEach({ msw }) {
		msw.use(...appHandlers({ messages: { [growthDesk.id]: messagesInChat } }));
	},
	render: () => <StoryApp path={chatPath(growthDesk)} />,
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" });
		await expect(await within(log).findByText(/Two asked for pricing/)).toBeInTheDocument();
		await expect(canvas.getByRole("link", { name: `Back to ${growthDesk.name}` })).toBeVisible();
	},
});
