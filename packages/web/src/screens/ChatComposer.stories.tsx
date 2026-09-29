import type { ThreadParticipant } from "@sugabots/contracts";
import { useEffect, useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { ChatComposer } from "./ChatComposer.tsx";

const mentionable: ThreadParticipant[] = [
	{
		kind: "agent",
		id: "0199a3a0-0000-7000-8000-000000000001",
		name: "Issue Triager",
		handle: "issue-triager",
		color: "green",
		face: "arc",
	},
	{
		kind: "agent",
		id: "0199a3a0-0000-7000-8000-000000000003",
		name: "Linear Handler",
		handle: "linear-handler",
		color: "orange",
		face: "dot",
	},
	{
		kind: "person",
		id: "0199a3a0-0000-7000-8000-000000000002",
		name: "Sam Rivera",
		handle: "sam-rivera",
		image: null,
	},
];

const meta = preview.meta({
	title: "Product/ChatComposer",
	component: ChatComposer,
	tags: ["ai-generated"],
	args: {
		label: "Message Growth Desk",
		placeholder: "Message Growth Desk",
		value: "",
		onValueChange: fn(),
		onSubmit: fn(),
		submitLabel: "Send message",
		submitDisabled: false,
		mentionable,
	},
	decorators: [
		(Story) => (
			<div className="mx-auto flex min-h-80 items-end py-4">
				<div className="w-full">
					<Story />
				</div>
			</div>
		),
	],
	render: function Composer(args) {
		const [value, setValue] = useState(args.value);
		useEffect(() => setValue(args.value), [args.value]);
		return (
			<ChatComposer
				{...args}
				value={value}
				onValueChange={(next) => {
					setValue(next);
					args.onValueChange(next);
				}}
				submitDisabled={args.submitDisabled || !value.trim()}
			/>
		);
	},
});

/** Empty is the composer before anything is typed: the send button stays grey. */
export const Empty = meta.story({});

/** Draft grows to fit a multi-line message instead of scrolling it out of sight. */
export const Draft = meta.story({
	args: {
		value: "Please summarise the customer feedback.\nHighlight anything we should act on today.",
	},
	play: async ({ canvas }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		await expect(input.scrollHeight).toBe(input.clientHeight);
	},
});

/** LongDraft stops growing at the composer's maximum height and scrolls beyond it. */
export const LongDraft = meta.story({
	args: {
		value: [
			"Please summarise the customer feedback from the last sprint.",
			"Highlight anything we should act on today.",
			"Group the rest by theme so we can plan next week.",
			"Then post the summary back in this thread.",
			"Mention anyone who already has a fix in flight.",
			"Finish with the three things you would do first.",
			"Keep it short enough to read on a phone.",
		].join("\n"),
	},
	play: async ({ canvas }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		await expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
	},
});

/** Typing `@` offers everyone the message can mention, above the composer. */
export const Mentions = meta.story({
	tags: ["ai-generated"],
	play: async ({ canvas, userEvent }) => {
		await userEvent.type(canvas.getByRole("textbox", { name: "Message Growth Desk" }), "@");
		await expect(canvas.getByRole("listbox", { name: "People and bots to mention" })).toBeVisible();
		await expect(canvas.getAllByRole("option")).toHaveLength(3);
	},
});

/**
 * SelectMention narrows the list by name as it is typed, moves with the arrow
 * keys, and writes the chosen handle on Enter without sending the draft.
 */
export const SelectMention = meta.story({
	tags: ["ai-generated"],
	play: async ({ canvas, userEvent, args }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		await userEvent.type(input, "Ask @ri");
		await expect(canvas.getAllByRole("option")).toHaveLength(2);
		await expect(input).toHaveAttribute(
			"aria-activedescendant",
			canvas.getByRole("option", { name: /Issue Triager/, selected: true }).id,
		);
		await userEvent.keyboard("{ArrowDown}");
		await expect(input).toHaveAttribute(
			"aria-activedescendant",
			canvas.getByRole("option", { name: /Sam Rivera/, selected: true }).id,
		);
		await userEvent.keyboard("{Enter}");
		await expect(input).toHaveValue("Ask @sam-rivera ");
		await expect(canvas.queryByRole("listbox")).not.toBeInTheDocument();
		await expect(input).not.toHaveAttribute("aria-activedescendant");
		await expect(args.onSubmit).not.toHaveBeenCalled();
	},
});

/**
 * Escape closes the list for that mention and leaves what was typed. A name
 * with no match, an `@` inside an email address, or an `@` and then a space
 * never opens it.
 */
export const DismissMention = meta.story({
	tags: ["ai-generated"],
	play: async ({ canvas, userEvent }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		await userEvent.type(input, "@sam");
		await expect(canvas.getByRole("listbox")).toBeVisible();
		await userEvent.keyboard("{Escape}");
		await expect(canvas.queryByRole("listbox")).not.toBeInTheDocument();
		await expect(input).toHaveValue("@sam");
		await userEvent.clear(input);
		await userEvent.type(input, "@nobody");
		await expect(canvas.queryByRole("listbox")).not.toBeInTheDocument();
		// An email address is not a mention; a handle after an opening bracket is.
		await userEvent.clear(input);
		await userEvent.type(input, "sam@");
		await expect(canvas.queryByRole("listbox")).not.toBeInTheDocument();
		await userEvent.clear(input);
		await userEvent.type(input, "(@sam");
		await expect(canvas.getByRole("listbox")).toBeVisible();
		// An `@` followed by a space means "at", so Enter still sends.
		await userEvent.clear(input);
		await userEvent.type(input, "meet @ ");
		await expect(canvas.queryByRole("listbox")).not.toBeInTheDocument();
		// Closing one mention's list leaves another mention's list free to open.
		await userEvent.clear(input);
		await userEvent.type(input, "@sam and @li");
		await userEvent.keyboard("{Escape}");
		await expect(canvas.queryByRole("listbox")).not.toBeInTheDocument();
		await userEvent.keyboard("{ArrowLeft>8/}");
		await expect(canvas.getByRole("option", { name: /Sam Rivera/ })).toBeVisible();
	},
});

/**
 * With the list open, Shift+Enter still breaks the line, and choosing someone
 * with the cursor inside a handle replaces the whole handle.
 */
export const EditMention = meta.story({
	tags: ["ai-generated"],
	play: async ({ canvas, userEvent }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		await userEvent.type(input, "@sam");
		await expect(canvas.getByRole("listbox")).toBeVisible();
		await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
		await expect(input).toHaveValue("@sam\n");

		await userEvent.clear(input);
		await userEvent.type(input, "@sam-rivera hello");
		// Back to just after "@sam", inside the handle.
		await userEvent.keyboard("{ArrowLeft>13/}");
		await expect(canvas.getByRole("listbox")).toBeVisible();
		await userEvent.keyboard("{Enter}");
		await expect(input).toHaveValue("@sam-rivera hello");
	},
});

/** SendWithEnter submits the draft while Shift+Enter preserves a line break. */
export const SendWithEnter = meta.story({
	args: { value: "First line\nSecond line" },
	play: async ({ canvas, userEvent, args }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		await userEvent.clear(input);
		await userEvent.type(input, "First line");
		await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
		await userEvent.type(input, "Second line");
		await expect(input).toHaveValue("First line\nSecond line");
		await expect(args.onSubmit).not.toHaveBeenCalled();
		await userEvent.keyboard("{Enter}");
		await expect(args.onSubmit).toHaveBeenCalledOnce();
	},
});

/** Sending holds the draft while the message is on its way. */
export const Sending = meta.story({
	args: {
		value: "Please summarise the feedback.",
		submitDisabled: true,
		submitLabel: "Sending message",
	},
});

/** SendFailed preserves the draft and exposes the error beside the retry action. */
export const SendFailed = meta.story({
	args: { value: "Please summarise the feedback.", error: "Could not send. Try again." },
});
