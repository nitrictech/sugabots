import type { Message } from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { expect, type screen, within } from "storybook/test";
import preview from "#storybook/preview";
import {
	directMessages,
	marco,
	priya,
	theo,
	withFormerMember,
	withGroup,
	withPriya,
	withPriyaAndTheo,
	withTheo,
} from "@/shell/story-fixtures.ts";
import { appHandlers, StoryApp, storyUser, storyWorkspace } from "@/story-app.tsx";

/*
 * A direct message as the app shows it: between people, one other or a
 * group, which nobody else sees and no bot answers. Each goes by the others'
 * names, with no thread controls, and Back on a phone returns to the list of
 * them.
 */

const me = testPerson({ id: storyUser.id, name: storyUser.name, email: storyUser.email });

function said(id: string, threadId: string, author: Message["author"], text: string, at: string) {
	return {
		id: `0199a3a0-0000-7000-8000-0000000007${id}`,
		threadId,
		author,
		kind: "text",
		status: "complete",
		parts: [{ type: "text", text }],
		content: text,
		createdAt: at,
	} satisfies Message;
}

const priyaThread = withPriya.conversation.id;
const smallGroupThread = withPriyaAndTheo.conversation.id;

const messages: Record<string, Message[]> = {
	[priyaThread]: [
		said("01", priyaThread, me, "Morning! How did the Acme call go?", "2026-09-18T05:50:00.000Z"),
		said(
			"02",
			priyaThread,
			priya,
			"Really well. They want the renewal at the same seats.",
			"2026-09-18T06:05:00.000Z",
		),
		said(
			"03",
			priyaThread,
			priya,
			"Can you look over the renewal deck before Thursday?",
			"2026-09-18T06:10:00.000Z",
		),
	],
	[smallGroupThread]: [
		said("11", smallGroupThread, priya, "Offsite is on for Friday.", "2026-09-18T05:30:00.000Z"),
		said("12", smallGroupThread, theo, "Who's bringing the projector?", "2026-09-18T05:40:00.000Z"),
	],
	[withFormerMember.conversation.id]: [
		said(
			"21",
			withFormerMember.conversation.id,
			testPerson({ id: "0199a3a0-0000-7000-8000-0000000005ff", name: "Dana Ford" }),
			"Handing over the Q3 notes here.",
			"2026-09-10T02:00:00.000Z",
		),
	],
};

const dm = (conversationId: string) => `/${storyWorkspace.slug}/dm/${conversationId}`;

const meta = preview.meta({
	title: "Views/Direct message",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		localStorage.removeItem("sugabots-folded");
		msw.use(
			...appHandlers({
				directMessages,
				directMessageMessages: messages,
				otherMembers: [priya, marco, theo],
			}),
		);
	},
});

/**
 * With a person: their name and face, a composer addressed to them, and no
 * Mark done; shaded among the sidebar's direct messages while it is open.
 */
export const WithAPerson = meta.story({
	render: () => <StoryApp path={dm(priyaThread)} />,
	play: async ({ canvas }) => {
		const log = await canvas.findByRole("log", { name: "Chat messages" }, { timeout: 10_000 });
		await expect(await within(log).findByText(/renewal deck/)).toBeInTheDocument();
		await expect(canvas.getByRole("heading", { level: 1, name: priya.name })).toBeVisible();
		await expect(canvas.getByRole("textbox", { name: `Message ${priya.name}` })).toBeVisible();
		await expect(canvas.queryByRole("button", { name: "Mark done" })).toBeNull();
		const section = canvas.getByRole("region", { name: "Direct messages" });
		await expect(within(section).getByRole("link", { name: /^Priya Shah(?!,)/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
	},
});

/** With a person, nothing written yet: where it starts. */
export const EmptyWithAPerson = meta.story({
	render: () => <StoryApp path={dm(withTheo.conversation.id)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText(
				/start of your direct messages with Theo Hart/,
				{},
				{ timeout: 10_000 },
			),
		).toBeInTheDocument();
	},
});

/**
 * With two others: their faces overlapping, their names, and at the right
 * how many are in it, which lists them.
 */
export const WithTwoOthers = meta.story({
	render: () => <StoryApp path={dm(smallGroupThread)} />,
	play: async ({ canvas }) => {
		const title = "Priya Shah and Theo Hart";
		await expect(
			await canvas.findByRole("heading", { level: 1, name: title }, { timeout: 10_000 }),
		).toBeVisible();
		await expect(canvas.getByRole("button", { name: /^3 members/ })).toBeVisible();
		await expect(
			await canvas.findByText(
				"This is a private conversation between Priya Shah, Theo Hart and you. Only the people here can see it.",
			),
		).toBeInTheDocument();
	},
});

/** With somebody who has left the workspace: they go by Former member. */
export const PersonWhoLeft = meta.story({
	render: () => <StoryApp path={dm(withFormerMember.conversation.id)} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { level: 1, name: "Former member" }, { timeout: 10_000 }),
		).toBeVisible();
		await expect(await canvas.findByText(/They have left the workspace/)).toBeInTheDocument();
	},
});

/** With a group: by their names, its intro saying only the people in it see it. */
export const WithAGroup = meta.story({
	render: () => <StoryApp path={dm(withGroup.conversation.id)} />,
	play: async ({ canvas }) => {
		const title = "Marco Bell, Priya Shah, Theo Hart and 1 former member";
		await expect(
			await canvas.findByRole("heading", { level: 1, name: title }, { timeout: 10_000 }),
		).toBeVisible();
		await expect(
			await canvas.findByText(
				/private conversation between Marco Bell, Priya Shah, Theo Hart, 1 former member and you/,
			),
		).toBeInTheDocument();
		await expect(canvas.getByRole("textbox", { name: `Message ${title}` })).toBeVisible();
	},
});

/** None open: what direct messages are, and New message. */
export const NoneOpen = meta.story({
	render: () => <StoryApp path={`/${storyWorkspace.slug}/dm`} />,
	play: async ({ canvas }) => {
		const main = await canvas.findByRole("main", {}, { timeout: 10_000 });
		await expect(await within(main).findByRole("link", { name: "New message" })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/dm/new`,
		);
	},
});

const newMessage = `/${storyWorkspace.slug}/dm/new`;

/** The To field of the New message page. */
async function toField(canvas: { findByRole: typeof screen.findByRole }) {
	return canvas.findByRole("combobox", { name: "To:" }, { timeout: 10_000 });
}

/**
 * New message, empty: the To field, suggesting everybody else in the
 * workspace, those you have written to alone most recently first, and never
 * a group. Then the box for the first message.
 */
export const NewMessageEmpty = meta.story({
	render: () => <StoryApp path={newMessage} />,
	play: async ({ canvas }) => {
		await toField(canvas);
		const suggestions = await canvas.findByRole("listbox", { name: "Suggestions" });
		await within(suggestions).findByRole("option", { name: /^Theo Hart/ });
		const options = within(suggestions)
			.getAllByRole("option")
			.map((option) => option.textContent);
		await expect(options).toEqual([
			// Priya first, as you have written to her alone.
			expect.stringContaining("priya@nitric.io"),
			expect.stringContaining("marco@nitric.io"),
			expect.stringContaining("theo@nitric.io"),
		]);
		await expect(canvas.getByRole("textbox", { name: "Start a new message" })).toBeVisible();
	},
});

/**
 * Typing narrows the suggestions, Return adds the one marked, and Backspace
 * in the empty field takes the last back out.
 */
export const NewMessageFiltering = meta.story({
	render: () => <StoryApp path={newMessage} />,
	play: async ({ canvas, userEvent }) => {
		const field = await toField(canvas);
		await canvas.findByRole("option", { name: /^Theo Hart/ });
		await userEvent.type(field, "arc");
		const suggestions = canvas.getByRole("listbox", { name: "Suggestions" });
		await expect(within(suggestions).getAllByRole("option")).toHaveLength(1);
		await expect(
			within(suggestions).getByRole("option", { name: /^Marco Bell\s*marco@/ }),
		).toHaveAttribute("aria-selected", "true");
		await userEvent.keyboard("{Enter}");
		const recipients = canvas.getByRole("list", { name: "Recipients" });
		await expect(within(recipients).getByText("Marco Bell")).toBeVisible();
		await userEvent.keyboard("{Backspace}");
		await expect(canvas.queryByRole("list", { name: "Recipients" })).toBeNull();
	},
});

/**
 * Two people chosen: each a token that can be removed, the box addressed to
 * them, and a word on where the message goes. Choosing closes the
 * suggestions until another name is typed, and those chosen are no longer
 * among them.
 */
export const NewMessageWithTokens = meta.story({
	render: () => <StoryApp path={newMessage} />,
	play: async ({ canvas, userEvent }) => {
		await toField(canvas);
		await userEvent.click(await canvas.findByRole("option", { name: /^Priya Shah\s*priya@/ }));
		await expect(canvas.queryByRole("option")).toBeNull();
		await userEvent.type(canvas.getByRole("combobox", { name: "To:" }), "Mar");
		await userEvent.click(await canvas.findByRole("option", { name: /^Marco Bell\s*marco@/ }));
		const recipients = canvas.getByRole("list", { name: "Recipients" });
		await expect(within(recipients).getAllByRole("listitem")).toHaveLength(2);
		await expect(canvas.getByRole("button", { name: "Remove Priya Shah" })).toBeVisible();
		// Writing the message, the page says whom it goes to.
		await userEvent.click(
			canvas.getByRole("textbox", { name: "Message Priya Shah and Marco Bell" }),
		);
		await expect(canvas.getByText(/starts a conversation that only the people/)).toBeVisible();
		await userEvent.type(canvas.getByRole("combobox", { name: "To:" }), "i");
		await expect(canvas.queryByRole("option", { name: /^Priya Shah\s*priya@/ })).toBeNull();
	},
});

/**
 * Choosing people there is a conversation with already shows it, under the To
 * field, to write in there and then; sending opens it.
 */
export const NewMessageToAGroup = meta.story({
	beforeEach({ msw }) {
		msw.use(
			...appHandlers({
				directMessages: directMessages.map((item) =>
					item === withGroup ? { ...withGroup, people: [marco, theo], formerMembers: 0 } : item,
				),
				directMessageMessages: messages,
				otherMembers: [priya, marco, theo],
			}),
		);
	},
	render: () => <StoryApp path={newMessage} />,
	play: async ({ canvas, userEvent }) => {
		await toField(canvas);
		await userEvent.click(await canvas.findByRole("option", { name: /^Marco Bell/ }));
		await userEvent.type(canvas.getByRole("combobox"), "Theo");
		await userEvent.click(await canvas.findByRole("option", { name: /^Theo Hart/ }));
		await userEvent.type(
			await canvas.findByRole(
				"textbox",
				{ name: "Message Marco Bell and Theo Hart" },
				{ timeout: 10_000 },
			),
			"Lunch after the offsite?",
		);
		await userEvent.keyboard("{Enter}");
		await expect(
			await canvas.findByRole(
				"heading",
				{ level: 1, name: "Marco Bell and Theo Hart" },
				{ timeout: 10_000 },
			),
		).toBeVisible();
		await expect(await canvas.findByText("Lunch after the offsite?")).toBeInTheDocument();
	},
});

/** New message on a phone: the To field under Back, and the box above the keyboard. */
export const NewMessageOnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	render: () => <StoryApp path={newMessage} />,
	play: async ({ canvas }) => {
		await toField(canvas);
		await expect(canvas.getByRole("link", { name: "Back to Direct messages" })).toBeVisible();
		await expect(canvas.getByRole("textbox", { name: "Start a new message" })).toBeVisible();
	},
});

/**
 * On a phone, the direct messages are the first place in Home's rail: each
 * with its latest message, and + to start another.
 */
export const PhoneList = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	render: () => <StoryApp path={`/${storyWorkspace.slug}/dm`} />,
	play: async ({ canvas }) => {
		const rail = await canvas.findByRole(
			"navigation",
			{ name: "Direct messages and pods" },
			{ timeout: 10_000 },
		);
		await expect(within(rail).getByRole("link", { name: /^Direct messages/ })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.getByRole("heading", { level: 1, name: "Direct messages" })).toBeVisible();
		await expect(await canvas.findByText(/renewal deck before Thursday/)).toBeVisible();
	},
});

/** On a phone, a direct message covers the list, with Back to it. */
export const PhoneConversation = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	render: () => <StoryApp path={dm(priyaThread)} />,
	play: async ({ canvas }) => {
		await canvas.findByRole("log", { name: "Chat messages" }, { timeout: 10_000 });
		await expect(canvas.getByRole("link", { name: "Back to Direct messages" })).toBeVisible();
	},
});
