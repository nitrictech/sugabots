import type { ThreadParticipant } from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
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
	testPerson({ id: "0199a3a0-0000-7000-8000-000000000002", name: "Sam Rivera" }),
];

const meta = preview.meta({
	title: "Product/ChatComposer",
	component: ChatComposer,
	tags: ["ai-generated"],
	args: {
		label: "Message Growth Desk",
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
		const [peopleOnly, setPeopleOnly] = useState(args.peopleOnly?.on ?? false);
		useEffect(() => setPeopleOnly(args.peopleOnly?.on ?? false), [args.peopleOnly?.on]);
		return (
			<ChatComposer
				{...args}
				peopleOnly={
					args.peopleOnly && {
						...args.peopleOnly,
						on: peopleOnly,
						onChange: (on) => {
							setPeopleOnly(on);
							args.peopleOnly?.onChange(on);
						},
					}
				}
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

/** Empty is the composer before anything is typed: Send stays grey until there is something to send. */
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
			"Link the tickets you used.",
			"And note anything still unclear.",
		].join("\n"),
	},
	play: async ({ canvas }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		await expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
	},
});

/**
 * SelectMention offers everyone on `@`, narrows the list by name as it is
 * typed, spaces included, moves with the arrow keys, and writes the chosen
 * handle on Enter without sending the draft.
 */
export const SelectMention = meta.story({
	tags: ["ai-generated"],
	play: async ({ canvas, userEvent, args }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		await userEvent.type(input, "Ask @");
		await expect(canvas.getByRole("listbox", { name: "People and bots to mention" })).toBeVisible();
		await expect(canvas.getAllByRole("option")).toHaveLength(3);
		await userEvent.type(input, "ri");
		await expect(canvas.getAllByRole("option")).toHaveLength(2);
		await userEvent.keyboard("{ArrowDown}");
		await expect(input).toHaveAttribute(
			"aria-activedescendant",
			canvas.getByRole("option", { name: /Sam Rivera/, selected: true }).id,
		);
		await userEvent.keyboard("{Enter}");
		await expect(input).toHaveValue("Ask @sam-rivera ");
		await expect(canvas.queryByRole("listbox")).not.toBeInTheDocument();
		await expect(args.onSubmit).not.toHaveBeenCalled();
		// A name is matched as it is written, spaces and all.
		await userEvent.clear(input);
		await userEvent.type(input, "@Sam Ri");
		await expect(canvas.getAllByRole("option")).toHaveLength(1);
	},
});

/**
 * Escape closes the list and leaves what was typed. An `@` inside an email
 * address, or an `@` and then a space, never opens it.
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
		await userEvent.type(input, "sam@");
		await expect(canvas.queryByRole("listbox")).not.toBeInTheDocument();
		await userEvent.clear(input);
		await userEvent.type(input, "meet @ ");
		await expect(canvas.queryByRole("listbox")).not.toBeInTheDocument();
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

/** The @ starts a mention where the cursor is, opening the same list as typing `@`. */
export const MentionButton = meta.story({
	args: { value: "Can you ask" },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Mention a bot or person" }));
		await expect(canvas.getByRole("textbox", { name: "Message Growth Desk" })).toHaveValue(
			"Can you ask @",
		);
		await expect(
			await canvas.findByRole("listbox", { name: "People and bots to mention" }),
		).toBeVisible();
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

const growthDesk = { name: "Growth Desk", color: "green", face: "arc" } as const;

/**
 * WithPeople is a thread with someone else in it: the people button beside
 * the @, or Tab, moves to people only and back. Tab
 * picks a mention instead while the mention list is open.
 */
export const WithPeople = meta.story({
	args: { peopleOnly: { on: false, onChange: fn(), agent: growthDesk } },
	play: async ({ canvas, userEvent }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		const chip = canvas.getByRole("button", { name: "People only" });
		await expect(chip).toHaveAttribute("aria-pressed", "false");
		await expect(chip).not.toHaveTextContent("People only");
		await userEvent.click(input);
		await userEvent.keyboard("{Tab}");
		await expect(chip).toHaveAttribute("aria-pressed", "true");
		await expect(input).toHaveFocus();
		await userEvent.keyboard("{Tab}");
		await expect(chip).toHaveAttribute("aria-pressed", "false");

		await userEvent.type(input, "@sam");
		await userEvent.keyboard("{Tab}");
		await expect(input).toHaveValue("@sam-rivera ");
		await expect(chip).toHaveAttribute("aria-pressed", "false");

		await userEvent.click(chip);
		await expect(chip).toHaveAttribute("aria-pressed", "true");
	},
});

/**
 * PeopleOnly writes to the other people, named in the placeholder: the chip
 * says so, the edge steps up a grey and Send goes neutral, since the accent is
 * the bot's. Clicking the chip goes back to the bot.
 */
export const PeopleOnly = meta.story({
	args: {
		label: "Message Jay Yu and Priya Kaur",
		value: "Can one of you check the quote?",
		peopleOnly: { on: true, onChange: fn(), agent: growthDesk },
	},
	play: async ({ args, canvas, userEvent }) => {
		const chip = canvas.getByRole("button", { name: "People only" });
		await expect(chip).toHaveTextContent("People only");
		await userEvent.click(chip);
		await expect(args.peopleOnly?.onChange).toHaveBeenCalledWith(false);
	},
});
