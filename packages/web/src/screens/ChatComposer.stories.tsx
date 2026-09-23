import type { ThreadParticipant } from "@sugabots/contracts";
import { useEffect, useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { ChatComposer } from "./ChatComposer.tsx";

const participants: ThreadParticipant[] = [
	{
		kind: "agent",
		id: "0199a3a0-0000-7000-8000-000000000001",
		name: "Issue Triager",
		handle: "issue-triager",
		hue: 150,
		face: "smile",
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
		label: "Message",
		placeholder: "Message the team, or @mention someone…",
		value: "",
		onValueChange: fn(),
		onSubmit: fn(),
		submitLabel: "Send message",
		submitDisabled: false,
		mentionables: participants,
	},
	decorators: [
		(Story) => (
			<div className="mx-auto flex min-h-80 max-w-home items-end py-4">
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

export const Empty = meta.story({});

/** Draft grows to fit a multi-line message instead of scrolling it out of sight. */
export const Draft = meta.story({
	args: {
		value: "Please summarise the customer feedback.\nHighlight anything we should act on today.",
	},
	play: async ({ canvas }) => {
		const input = canvas.getByRole("textbox", { name: "Message" });
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
		const input = canvas.getByRole("textbox", { name: "Message" });
		await expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
	},
});

/** Mentions exposes thread participants without requiring a live conversation. */
export const Mentions = meta.story({
	parameters: { docs: { story: { autoplay: true } } },
	play: async ({ canvas, userEvent }) => {
		await userEvent.type(canvas.getByRole("textbox", { name: "Message" }), "@");
		await expect(
			canvas.getByRole("listbox", { name: "People and agents in this thread" }),
		).toBeVisible();
	},
});

/** SelectMention uses the keyboard to insert a participant handle into the draft. */
export const SelectMention = meta.story({
	args: { value: "@issue-triager " },
	play: async ({ canvas, userEvent, args }) => {
		const input = canvas.getByRole("textbox", { name: "Message" });
		await userEvent.clear(input);
		await userEvent.type(input, "@");
		await expect(input).toHaveAttribute(
			"aria-activedescendant",
			canvas.getByRole("option", { name: /Issue Triager/, selected: true }).id,
		);
		await userEvent.keyboard("{ArrowDown}");
		await expect(input).toHaveAttribute(
			"aria-activedescendant",
			canvas.getByRole("option", { name: /Sam Rivera/, selected: true }).id,
		);
		await userEvent.keyboard("{ArrowUp}");
		await userEvent.keyboard("{Enter}");
		await expect(input).toHaveValue("@issue-triager ");
		await expect(canvas.queryByRole("listbox")).not.toBeInTheDocument();
		await expect(input).not.toHaveAttribute("aria-activedescendant");
		await expect(args.onSubmit).not.toHaveBeenCalled();
	},
});

/** SendWithEnter submits the draft while Shift+Enter preserves a line break. */
export const SendWithEnter = meta.story({
	args: { value: "First line\nSecond line" },
	play: async ({ canvas, userEvent, args }) => {
		const input = canvas.getByRole("textbox", { name: "Message" });
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
