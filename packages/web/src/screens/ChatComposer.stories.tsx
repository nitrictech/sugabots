import { useEffect, useState } from "react";
import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { ChatComposer } from "./ChatComposer.tsx";

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
