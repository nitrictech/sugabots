import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { DirectMessageCards, DirectMessagesSection } from "./DirectMessages.tsx";
import {
	directMessages,
	withFormerMember,
	withGroup,
	withMarco,
	withPriya,
	withPriyaAndTheo,
} from "./story-fixtures.ts";

/*
 * Direct messages, as the sidebar lists them under the pods: with one person
 * or a group, most recent first, and New message as the last row.
 */

const meta = preview.meta({
	title: "Product/Direct messages",
	component: DirectMessagesSection,
	tags: ["ai-generated"],
	args: {
		items: directMessages,
		status: "ready",
		selectedConversationId: withMarco.conversation.id,
	},
	beforeEach: () => {
		localStorage.removeItem("sugabots-folded");
	},
	decorators: [
		(Story) => (
			<nav aria-label="Sidebar" className="@container/sidebar w-68 bg-rail p-3">
				<Story />
			</nav>
		),
	],
});

/**
 * Each direct message by the person's face, or a group's two overlapping:
 * bold and counted while something in it is unread, and shaded while it is
 * open. A group goes by its people's names; somebody who has left by Former
 * member. New message comes last.
 */
export const Default = meta.story({
	play: async ({ canvas }) => {
		const priya = canvas.getByRole("link", { name: /^Priya Shah\s*2 unread/ });
		await expect(priya).toHaveAttribute(
			"href",
			expect.stringMatching(new RegExp(`/dm/${withPriya.conversation.id}$`)),
		);
		await expect(canvas.getByRole("link", { name: /^Priya, Theo/ })).toHaveTextContent(
			"1 unread message",
		);
		await expect(
			canvas.getByRole("link", { name: /^Marco, Priya, Theo, 1 former member/ }),
		).toHaveAttribute(
			"href",
			expect.stringMatching(new RegExp(`/dm/${withGroup.conversation.id}$`)),
		);
		await expect(canvas.getByRole("link", { name: "Marco Bell" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.getByRole("link", { name: /^Former member/ })).toBeVisible();
		const links = canvas.getAllByRole("link");
		await expect(links.at(-1)).toHaveAccessibleName("New message");
		await expect(links.at(-1)).toHaveAttribute("href", expect.stringMatching(/\/dm\/new$/));
	},
});

/** Folded away, the heading says what is new in them. */
export const Folded = meta.story({
	play: async ({ canvas, userEvent }) => {
		const heading = canvas.getByRole("button", { name: "Direct messages" });
		await userEvent.click(heading);
		await expect(heading).toHaveAttribute("aria-expanded", "false");
		await expect(canvas.queryByRole("link", { name: /^Priya Shah/ })).toBeNull();
		await expect(canvas.getByRole("heading", { name: /^Direct messages/ })).toHaveTextContent(
			"4 unread messages",
		);
	},
});

/** None yet: only New message. */
export const Empty = meta.story({
	args: { items: [], selectedConversationId: undefined },
	play: async ({ canvas }) => {
		await expect(canvas.getAllByRole("link")).toHaveLength(1);
		await expect(canvas.getByRole("link", { name: "New message" })).toHaveAttribute(
			"href",
			expect.stringMatching(/\/dm\/new$/),
		);
	},
});

/** The list could not be loaded. */
export const Failed = meta.story({
	args: { items: [], status: "failed" },
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Could not load your direct messages.")).toBeVisible();
	},
});

/**
 * A phone's page of them: each with its latest message and when, and what is
 * new in it, sized for a thumb.
 */
export const OnAPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	render: () => (
		<div className="w-full max-w-97.5 bg-list p-2">
			<DirectMessageCards
				items={[withPriya, withPriyaAndTheo, withGroup, withMarco, withFormerMember]}
				status="ready"
			/>
		</div>
	),
	play: async ({ canvas }) => {
		const [priya] = canvas.getAllByRole("link");
		if (!priya) throw new Error("No direct messages listed");
		await expect(
			within(priya).getByText("Can you look over the renewal deck before Thursday?"),
		).toBeVisible();
		await expect(priya).toHaveTextContent("2 unread messages");
	},
});

/** A phone with none yet: what to tap to start one. */
export const OnAPhoneEmpty = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	render: () => (
		<div className="w-full max-w-97.5 bg-list p-2">
			<DirectMessageCards items={[]} status="ready" />
		</div>
	),
	play: async ({ canvas }) => {
		await expect(canvas.getByText(/No direct messages yet/)).toBeVisible();
	},
});
