import type { ThreadParticipant } from "@sugabots/contracts";
import { testPerson } from "@sugabots/contracts/testing";
import { useEffect, useState } from "react";
import { expect, fn, spyOn, within } from "storybook/test";
import preview from "#storybook/preview";
import type { ComposerAttachment } from "@/lib/composer-attachments.ts";
import {
	acmeRequest,
	boardPackFailed,
	callRecordingTooLarge,
	installerRefused,
	invoicesAtLimit,
	pricingPageReady,
	pricingPageUploading,
} from "./attachment-story-fixtures.ts";
import { ChatComposer } from "./ChatComposer.tsx";

/** Files attached in a fixed state, with spies for what the composer asks of them. */
function withFiles(items: readonly ComposerAttachment[], leftOut = 0) {
	return { items, leftOut, attach: fn(), remove: fn(), retry: fn() };
}

const mentionable: ThreadParticipant[] = [
	{
		kind: "agent",
		id: "0199a3a0-0000-7000-8000-000000000001",
		name: "Issue Triager",
		handle: "issue-triager",
		color: "green",
		face: "arc",
		shape: "circle",
	},
	{
		kind: "agent",
		id: "0199a3a0-0000-7000-8000-000000000003",
		name: "Linear Handler",
		handle: "linear-handler",
		color: "orange",
		face: "dot",
		shape: "circle",
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
		mentionable,
		attachments: withFiles([]),
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
		await expect(args.onValueChange).toHaveBeenLastCalledWith("Ask @sam-rivera ");
		// The chosen person shows in the draft as a chip of their name.
		await expect(within(input).getByText("@sam-rivera")).toBeVisible();
		await expect(canvas.queryByRole("listbox")).not.toBeInTheDocument();
		await expect(args.onSubmit).not.toHaveBeenCalled();
		// A name is matched as it is written, spaces and all.
		await userEvent.clear(input);
		await userEvent.type(input, "@Sam Ri");
		await expect(canvas.getAllByRole("option")).toHaveLength(1);
	},
});

/** Typing `@` and taking it back leaves the draft empty, not a new line. */
export const TakeBackMention = meta.story({
	play: async ({ args, canvas, userEvent }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		await userEvent.type(input, "@{Backspace}");
		await expect(args.onValueChange).toHaveBeenLastCalledWith("");
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
		await expect(input.textContent).toBe("@sam");
		await userEvent.clear(input);
		await userEvent.type(input, "sam@");
		await expect(canvas.queryByRole("listbox")).not.toBeInTheDocument();
		await userEvent.clear(input);
		await userEvent.type(input, "meet @ ");
		await expect(canvas.queryByRole("listbox")).not.toBeInTheDocument();
	},
});

/**
 * With the list open, Shift+Enter still breaks the line. A handle typed out in
 * full becomes a chip once a space follows it, and one Backspace removes it.
 */
export const EditMention = meta.story({
	tags: ["ai-generated"],
	play: async ({ args, canvas, userEvent }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		await userEvent.type(input, "@sam");
		await expect(canvas.getByRole("listbox")).toBeVisible();
		await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
		await expect(args.onValueChange).toHaveBeenLastCalledWith("@sam\n");

		await userEvent.clear(input);
		await userEvent.type(input, "@sam-rivera hello");
		await expect(within(input).getByText("@sam-rivera")).toBeVisible();
		await expect(args.onValueChange).toHaveBeenLastCalledWith("@sam-rivera hello");
		await userEvent.keyboard("{Backspace>7/}");
		await expect(within(input).queryByText("@sam-rivera")).not.toBeInTheDocument();
		await expect(args.onValueChange).toHaveBeenLastCalledWith("");
	},
});

/** The @ starts a mention where the cursor is, opening the same list as typing `@`. */
export const MentionButton = meta.story({
	args: { value: "Can you ask" },
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("textbox", { name: "Message Growth Desk" }));
		await userEvent.click(canvas.getByRole("button", { name: "Mention a bot or person" }));
		await expect(args.onValueChange).toHaveBeenLastCalledWith("Can you ask @");
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
		await expect(args.onValueChange).toHaveBeenLastCalledWith("First line\nSecond line");
		await expect(args.onSubmit).not.toHaveBeenCalled();
		await userEvent.keyboard("{Enter}");
		await expect(args.onSubmit).toHaveBeenCalledOnce();
	},
});

/** Sending holds the draft while the message is on its way. */
export const Sending = meta.story({
	args: {
		value: "Please summarise the feedback.",
		sending: true,
		submitLabel: "Sending message",
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: "Sending message" })).toBeDisabled();
	},
});

/** SendFailed preserves the draft and exposes the error beside the retry action. */
export const SendFailed = meta.story({
	args: { value: "Please summarise the feedback.", error: "Could not send. Try again." },
});

/**
 * Text run up against a chip, as when the space after it is deleted, is still
 * sent with the mention apart from it, so the mention still names the bot.
 */
export const TextAgainstAChip = meta.story({
	play: async ({ args, canvas, userEvent }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		await userEvent.type(input, "@issue-triager we can start");
		await expect(within(input).getByText("Issue Triager")).toBeVisible();
		// To just after the space that follows the chip, which goes.
		await userEvent.keyboard("{ArrowLeft>12/}{Backspace}");
		await expect(input.textContent).toBe("@Issue Triagerwe can start");
		await expect(args.onValueChange).toHaveBeenLastCalledWith("@issue-triager we can start");
	},
});

/** A mentioned bot shows in the draft as a chip of its face and name, where it was mentioned. */
export const MentionChip = meta.story({
	args: { value: "@issue-triager can you check the quote?" },
	play: async ({ canvas }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		await expect(within(input).getByText("Issue Triager")).toBeVisible();
		await expect(input.textContent).toBe("@Issue Triager can you check the quote?");
	},
});

/**
 * LineKeysPastAChip: ⇧⌘← selects to the start of the line and ⌘⌫ deletes to
 * it, going past a chip, where the browser on its own stops at the chip.
 */
export const LineKeysPastAChip = meta.story({
	args: { value: "@issue-triager can you check the quote?" },
	play: async ({ args, canvas, userEvent }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		await userEvent.click(input);
		await userEvent.keyboard("{End}{Shift>}{Meta>}{ArrowLeft}{/Meta}{/Shift}");
		// The range, not the selection, reads out a chip, whose text can't be selected on its own.
		await expect(document.getSelection()?.getRangeAt(0).toString()).toBe(
			"@Issue Triager can you check the quote?",
		);
		await userEvent.keyboard("{End}{Meta>}{Backspace}{/Meta}");
		await expect(args.onValueChange).toHaveBeenLastCalledWith("");
	},
});

/**
 * ReplyingTo is a draft answering a message: the strip over it names whom and
 * what, and its × or Escape stops replying, leaving the draft as it is.
 */
export const ReplyingTo = meta.story({
	args: {
		value: "Add the pricing page fix too",
		replyingTo: {
			message: {
				id: "0199a3a0-0000-7000-8000-000000000c11",
				author: mentionable[0] as Extract<ThreadParticipant, { kind: "agent" }>,
				preview:
					"The release notes are drafted. Checkout gets the retry fix, and search gets the new filters.",
			},
			onCancel: fn(),
		},
	},
	play: async ({ args, canvas, userEvent }) => {
		await expect(canvas.getByText("Issue Triager")).toBeVisible();
		await userEvent.click(canvas.getByRole("button", { name: "Cancel reply" }));
		await expect(args.replyingTo?.onCancel).toHaveBeenCalledTimes(1);
		await userEvent.click(canvas.getByRole("textbox", { name: "Message Growth Desk" }));
		await userEvent.keyboard("{Escape}");
		await expect(args.replyingTo?.onCancel).toHaveBeenCalledTimes(2);
		await expect(args.onValueChange).not.toHaveBeenCalled();
	},
});

/** The paperclip sits left of the @ and opens the system's file picker straight away. */
export const AttachFiles = meta.story({
	play: async ({ canvas, canvasElement, userEvent }) => {
		const picker = canvasElement.querySelector<HTMLInputElement>('input[type="file"]');
		if (!picker) throw new Error("The composer has no file picker");
		// The real picker is the system's own window, which a test cannot close.
		const openPicker = spyOn(picker, "click").mockImplementation(() => {});
		await userEvent.click(canvas.getByRole("button", { name: "Attach files" }));
		await expect(openPicker).toHaveBeenCalledOnce();
	},
});

/**
 * Before the chat exists there is nowhere to upload to: the paperclip is off,
 * and a pasted file writes nothing into the draft.
 */
export const BeforeTheChatExists = meta.story({
	args: { attachments: { ...withFiles([]), attach: undefined } },
	play: async ({ canvas, canvasElement, userEvent }) => {
		const attachButton = canvas.getByRole("button", { name: "Attach files" });
		await expect(attachButton).toHaveAttribute("aria-disabled", "true");
		const picker = canvasElement.querySelector<HTMLInputElement>('input[type="file"]');
		if (!picker) throw new Error("The composer has no file picker");
		const openPicker = spyOn(picker, "click").mockImplementation(() => {});
		await userEvent.click(attachButton);
		await expect(openPicker).not.toHaveBeenCalled();

		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		const pasted = new DataTransfer();
		pasted.items.add(new File(["png"], "image.png", { type: "image/png" }));
		const paste = new ClipboardEvent("paste", {
			bubbles: true,
			cancelable: true,
			clipboardData: pasted,
		});
		input.dispatchEvent(paste);
		await expect(input.textContent).toBe("");
	},
});

/** Files chosen in the system's picker are attached in the order chosen. */
export const ChooseFiles = meta.story({
	play: async ({ args, canvasElement, userEvent }) => {
		const picker = canvasElement.querySelector<HTMLInputElement>('input[type="file"]');
		if (!picker) throw new Error("The composer has no file picker");
		const files = [
			new File(["%PDF"], "acme-retail-request.pdf", { type: "application/pdf" }),
			new File(["a,b"], "q4-pipeline.csv", { type: "text/csv" }),
		];
		await userEvent.upload(picker, files);
		await expect(args.attachments.attach).toHaveBeenCalledWith(files);
	},
});

/** Pasting a file, such as a screenshot, attaches it rather than writing anything into the draft. */
export const PasteFiles = meta.story({
	play: async ({ args, canvas, userEvent }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		const screenshot = new File(["png"], "image.png", { type: "image/png" });
		const clipboard = new DataTransfer();
		clipboard.items.add(screenshot);
		await userEvent.click(input);
		await userEvent.paste(clipboard);
		await expect(args.attachments.attach).toHaveBeenCalledWith([screenshot]);
		await expect(input.textContent).toBe("");
	},
});

/**
 * Cells copied from a spreadsheet, or text from a document, come with a
 * picture of them beside the text: the text is what is pasted.
 */
export const PasteFromOffice = meta.story({
	play: async ({ args, canvas, userEvent }) => {
		const input = canvas.getByRole("textbox", { name: "Message Growth Desk" });
		const clipboard = new DataTransfer();
		clipboard.setData("text/plain", "Q3 revenue\t1.2M");
		clipboard.items.add(new File(["png"], "image.png", { type: "image/png" }));
		await userEvent.click(input);
		await userEvent.paste(clipboard);
		await expect(args.onValueChange).toHaveBeenLastCalledWith("Q3 revenue\t1.2M");
		await expect(args.attachments.attach).not.toHaveBeenCalled();
	},
});

/**
 * Attaching: an image uploading, a PDF done and a video too large to send.
 * Send stays off, and says why, until the upload finishes and the failed file
 * is removed.
 */
export const Attaching = meta.story({
	args: { attachments: withFiles([pricingPageUploading, acmeRequest, callRecordingTooLarge]) },
	play: async ({ args, canvas, userEvent }) => {
		await expect(canvas.getByRole("button", { name: "Send message" })).toBeDisabled();
		await expect(canvas.getByText("Remove the file that failed")).toBeInTheDocument();
		await expect(
			canvas.getByRole("progressbar", { name: "Uploading pricing-page-new.svg" }),
		).toHaveAttribute("aria-valuenow", "64");
		// Too large to upload, so there is nothing to retry.
		await expect(
			canvas.queryByRole("button", { name: "Retry sales-call-recording.mp4" }),
		).not.toBeInTheDocument();
		await userEvent.click(canvas.getByRole("button", { name: "Remove sales-call-recording.mp4" }));
		await expect(args.attachments.remove).toHaveBeenCalledWith(callRecordingTooLarge.key);
	},
});

/** Files still uploading hold Send back, and the hint counts them. */
export const Uploading = meta.story({
	args: {
		value: "Here's the pricing page and Acme's request.",
		attachments: withFiles([
			pricingPageUploading,
			{ ...acmeRequest, upload: { state: "uploading", progress: 0.3 } },
		]),
	},
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: "Send message" })).toBeDisabled();
		await expect(canvas.getByText("2 files uploading")).toBeInTheDocument();
	},
});

/**
 * A failed upload blocks Send until it is retried or removed. Why it failed
 * is written beneath the files, and describes its buttons. Retry uploads it
 * again on the same chip.
 */
export const FailedBlocksSend = meta.story({
	args: {
		value: "Here's Acme's request, the new pricing page and the board pack.",
		attachments: withFiles([pricingPageReady, acmeRequest, boardPackFailed]),
	},
	play: async ({ args, canvas, userEvent }) => {
		await expect(canvas.getByRole("button", { name: "Send message" })).toBeDisabled();
		await expect(canvas.getByText("Remove or retry the file that failed")).toBeInTheDocument();
		await expect(canvas.getByText(/The upload didn't finish/)).toBeVisible();
		const retry = canvas.getByRole("button", { name: "Retry q3-board-pack-v2.pdf" });
		await expect(retry).toHaveAccessibleDescription(
			"q3-board-pack-v2.pdf: The upload didn't finish. Check your connection and retry.",
		);
		await expect(
			canvas.getByRole("button", { name: "Remove q3-board-pack-v2.pdf" }),
		).toHaveAccessibleDescription(/The upload didn't finish/);
		await userEvent.click(retry);
		await expect(args.attachments.retry).toHaveBeenCalledWith(boardPackFailed.key);
	},
});

/** A file the API refused for what it is offers no Retry, since it would only be refused again. */
export const RefusedFile = meta.story({
	args: { attachments: withFiles([acmeRequest, installerRefused]) },
	play: async ({ canvas }) => {
		await expect(canvas.getByText(/This kind of file can't be attached/)).toBeVisible();
		await expect(canvas.getByText("Remove the file that failed")).toBeInTheDocument();
		await expect(
			canvas.queryByRole("button", { name: "Retry setup-helper.exe" }),
		).not.toBeInTheDocument();
		await expect(
			canvas.getByRole("button", { name: "Remove setup-helper.exe" }),
		).toHaveAccessibleDescription(/This kind of file can't be attached/);
	},
});

/**
 * Removing a file from the keyboard keeps the focus among the files: on the
 * next one's remove button, or the one before when it was the last.
 */
export const RemoveFromKeyboard = meta.story({
	args: { attachments: withFiles([pricingPageReady, acmeRequest]) },
	render: function Removable(args) {
		const [items, setItems] = useState(args.attachments.items);
		return (
			<ChatComposer
				{...args}
				attachments={{
					...args.attachments,
					items,
					remove: (key) => {
						setItems((current) => current.filter((item) => item.key !== key));
						args.attachments.remove(key);
					},
				}}
			/>
		);
	},
	play: async ({ canvas, userEvent }) => {
		await userEvent.tab();
		await expect(canvas.getByRole("button", { name: "Remove pricing-page-new.svg" })).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		await expect(
			canvas.getByRole("button", { name: "Remove acme-retail-request.pdf" }),
		).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		await expect(canvas.getByRole("textbox", { name: "Message Growth Desk" })).toHaveFocus();
		await expect(canvas.queryByRole("list", { name: "Attached files" })).not.toBeInTheDocument();
	},
});

/** With two failed, the hint counts them. */
export const TwoFailed = meta.story({
	args: { attachments: withFiles([boardPackFailed, callRecordingTooLarge]) },
	play: async ({ canvas }) => {
		await expect(canvas.getByText("Remove or retry the 2 files that failed")).toBeInTheDocument();
	},
});

/** Text and two files, all uploaded, so Send turns on. */
export const ReadyToSend = meta.story({
	args: {
		value: "Here's Acme's request and the new pricing page. Can you check the numbers?",
		attachments: withFiles([pricingPageReady, acmeRequest]),
	},
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Send message" }));
		await expect(args.onSubmit).toHaveBeenCalledOnce();
	},
});

/** A message can be files only: with nothing typed, uploaded files still turn Send on. */
export const FilesOnly = meta.story({
	args: { attachments: withFiles([pricingPageReady, acmeRequest]) },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("button", { name: "Send message" })).toBeEnabled();
	},
});

/**
 * FileLimit: 23 files dropped and the first 20 attached. The note says what
 * was left out, the tray scrolls past two rows, and the paperclip turns off.
 */
export const FileLimit = meta.story({
	args: { attachments: withFiles(invoicesAtLimit, 3) },
	play: async ({ canvas }) => {
		await expect(
			canvas.getByText("3 files weren't added. A message can have 20 at most."),
		).toBeVisible();
		await expect(canvas.getByRole("button", { name: "Attach files" })).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		await expect(canvas.getByText("20 of 20 files")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Send message" })).toBeEnabled();
	},
});

/** On a phone the chips are a step smaller, in one row that scrolls sideways. */
export const AttachingOnPhone = meta.story({
	globals: { viewport: { value: "iphone12", isRotated: false } },
	args: { attachments: withFiles([pricingPageUploading, acmeRequest, callRecordingTooLarge]) },
	play: async ({ canvas }) => {
		await expect(
			canvas.getByRole("button", { name: "Remove acme-retail-request.pdf" }),
		).toBeInTheDocument();
	},
});
