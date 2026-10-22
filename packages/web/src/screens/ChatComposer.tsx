import {
	canStartMention,
	MAX_ATTACHMENTS_PER_MESSAGE,
	type MessageReplyTo,
	messageAuthorName,
	type ThreadParticipant,
} from "@sugabots/contracts";
import { cn } from "cn";
import { AtSign, Paperclip, Send, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
	type ComposerAttachment,
	type ComposerAttachments,
	canSend,
	sendReadiness,
} from "@/lib/composer-attachments.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { AttachmentTray, LeftOutNote } from "./ComposerAttachments.tsx";
import { MentionEditor, type MentionEditorHandle } from "./MentionEditor.tsx";

/** A 30px icon button on the row beneath the draft, such as the paperclip and the @. */
const toolButtonClassName =
	"focus-ring grid size-[30px] place-items-center rounded-tail text-muted-foreground transition-colors hover:bg-chip";

/**
 * Where a message is written: a box that grows with its text and sends on
 * Enter (Shift+Enter for a new line), with the paperclip, the @ and the send
 * button on a row beneath the draft. The paperclip attaches files, as dropping
 * or pasting them does; they sit above the text as they upload. Send is off
 * until there is text or a file and every file has uploaded, and while
 * `sending`. Typing `@`, or pressing the @, offers everyone in `mentionable`
 * whose name or handle matches what follows it; choosing one writes their
 * handle into the draft, where it shows as a chip of their face and name.
 * With `replyingTo`, a strip
 * over the draft names the message it answers; its × or Escape stops replying.
 */
export function ChatComposer({
	label,
	value,
	onValueChange,
	onSubmit,
	submitLabel,
	sending = false,
	error,
	className,
	mentionable,
	replyingTo,
	attachments,
	needsText = false,
}: {
	/** Names the box for assistive technology, and is its placeholder. */
	label: string;
	value: string;
	onValueChange: (value: string) => void;
	onSubmit: () => void | Promise<void>;
	submitLabel: string;
	/** A message is on its way, so another cannot be sent yet. */
	sending?: boolean;
	error?: ReactNode;
	className?: string;
	/** Who the draft can mention. */
	mentionable: ThreadParticipant[];
	/** The message the draft answers, quoted when it is sent. */
	replyingTo?: { message: MessageReplyTo; onCancel: () => void };
	/** The files attached to the message, and what attaches, removes and retries them. */
	attachments: Pick<ComposerAttachments, "items" | "leftOut" | "attach" | "remove" | "retry">;
	/** Send is off until the draft has words, as for a message that starts a thread, which is titled from them. */
	needsText?: boolean;
}) {
	const id = useId();
	const mentionListId = `${id}-mentions`;
	const editor = useRef<MentionEditorHandle>(null);
	const form = useRef<HTMLFormElement>(null);
	const [cursor, setCursor] = useState(value.length);
	const [activeMention, setActiveMention] = useState(0);
	/** Where the `@` of the mention whose menu was closed is, so only that one stays closed. */
	const [dismissedMentionAt, setDismissedMentionAt] = useState<number>();
	const typing = mentionBeingTyped(value, cursor);
	const matches = typing
		? mentionable.filter((candidate) => matchesQuery(candidate, typing.query))
		: [];
	const mentionMenuOpen = typing?.start !== dismissedMentionAt && matches.length > 0;
	const selectedMention = Math.min(activeMention, matches.length - 1);

	// Choosing Reply on a message goes straight on to writing the reply.
	const replyingToId = replyingTo?.message.id;
	useEffect(() => {
		if (replyingToId) editor.current?.focus();
	}, [replyingToId]);

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		if (mentionMenuOpen && !event.nativeEvent.isComposing) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				setActiveMention((selectedMention + step + matches.length) % matches.length);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setDismissedMentionAt(typing?.start);
				return;
			}
			// Shift+Enter still breaks the line, and Shift+Tab still moves the focus back.
			const unmodified = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
			if (unmodified && (event.key === "Enter" || event.key === "Tab")) {
				event.preventDefault();
				insertMention(matches[selectedMention]);
				return;
			}
		}
		if (replyingTo && event.key === "Escape" && !event.nativeEvent.isComposing) {
			event.preventDefault();
			replyingTo.onCancel();
			return;
		}
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		form.current?.requestSubmit();
	}

	function insertMention(participant: ThreadParticipant | undefined): void {
		if (!participant || !typing) return;
		// One space after the handle: the one already there, or a new one.
		const spaceAfter = value[typing.end] === " " ? 1 : 0;
		editor.current?.replace(
			{ start: typing.start, end: typing.end + spaceAfter },
			`@${participant.handle} `,
		);
	}

	/** Starts a mention at the cursor, as typing `@` would, so the same menu opens. */
	function startMention(): void {
		const at = Math.min(cursor, value.length);
		// After a word, a space first: an `@` straight after a letter is an email address.
		const lead = at > 0 && !/\s/.test(value[at - 1] ?? "") ? " @" : "@";
		editor.current?.replace({ start: at, end: at }, lead);
	}

	return (
		<form
			ref={form}
			onSubmit={(event) => {
				event.preventDefault();
				void onSubmit();
			}}
			className={cn("relative flex shrink-0 flex-col", className)}
		>
			{mentionMenuOpen && (
				<MentionMenu
					id={mentionListId}
					matches={matches}
					selected={selectedMention}
					onHighlight={setActiveMention}
					onChoose={insertMention}
				/>
			)}
			<div className="focus-ring-within flex flex-col rounded-xl border border-border-strong bg-panel transition-colors">
				{replyingTo && (
					<ReplyingToStrip message={replyingTo.message} onCancel={replyingTo.onCancel} />
				)}
				<AttachmentTray
					items={attachments.items}
					onRemove={attachments.remove}
					onRetry={attachments.retry}
					focusDraft={() => editor.current?.focus()}
				/>
				<LeftOutNote count={attachments.leftOut} />
				<div className="flex items-start gap-2.5 pt-2.5 pr-3 pb-1 pl-3">
					<MentionEditor
						ref={editor}
						id={id}
						label={label}
						value={value}
						mentionable={mentionable}
						maxLength={20_000}
						onValueChange={(next, caret) => {
							onValueChange(next);
							setCursor(caret);
							setActiveMention(0);
							setDismissedMentionAt(undefined);
						}}
						onCaretChange={setCursor}
						onFocus={() => setDismissedMentionAt(undefined)}
						onBlur={() => setDismissedMentionAt(typing?.start)}
						onKeyDown={handleKeyDown}
						onPaste={(event) => {
							const { files, types } = event.clipboardData;
							// Office apps put a picture of what was copied beside its text, which is what was meant.
							if (!attachments.attach || files.length === 0 || types.includes("text/plain")) return;
							event.preventDefault();
							attachments.attach([...files]);
						}}
						aria-controls={mentionMenuOpen ? mentionListId : undefined}
						aria-activedescendant={
							mentionMenuOpen ? `${mentionListId}-${selectedMention}` : undefined
						}
					/>
				</div>
				<div className="flex items-center gap-0.5 px-1.5 pt-1 pb-1.5">
					<AttachButton
						full={attachments.items.length >= MAX_ATTACHMENTS_PER_MESSAGE}
						onAttach={attachments.attach}
					/>
					<Tooltip label="Mention a bot or person" side="top">
						<button
							type="button"
							aria-label="Mention a bot or person"
							onClick={startMention}
							className={toolButtonClassName}
						>
							<AtSign size={16} strokeWidth={2} />
						</button>
					</Tooltip>
					<span className="flex-1" />
					<span className="pr-2 text-subtle-foreground text-xs [@media(hover:none)]:hidden">
						{sendHint(attachments.items)}
					</span>
					<button
						type="submit"
						aria-label={submitLabel}
						disabled={
							sending || !canSend(value, attachments.items) || (needsText && value.trim() === "")
						}
						className="focus-ring grid size-[30px] place-items-center rounded-[8px] bg-primary text-primary-foreground transition-colors hover:bg-primary-hover disabled:bg-chip-strong"
					>
						<Send size={15} strokeWidth={2.2} />
					</button>
				</div>
			</div>
			<div aria-live="polite" className="pt-1.5 pl-3 text-destructive-text text-sm empty:hidden">
				{error}
			</div>
		</form>
	);
}

/** Over the draft, the message it answers: its author and first line, and a × to stop replying. */
function ReplyingToStrip({ message, onCancel }: { message: MessageReplyTo; onCancel: () => void }) {
	const { author } = message;
	const name = messageAuthorName(author);
	return (
		<div className="flex items-center gap-2 border-border border-b py-1.5 pr-1.5 pl-3 text-[13px]">
			<p className="m-0 flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground">
				<span className="shrink-0">
					Replying to <span className="font-semibold text-soft-foreground">{name}</span>
				</span>
				<span className="min-w-0 truncate">{message.preview}</span>
			</p>
			<IconButton label="Cancel reply" side="top" onClick={onCancel}>
				<X aria-hidden />
			</IconButton>
		</div>
	);
}

/**
 * The paperclip, which opens the system's file picker. Off until the chat
 * exists, and once the message has as many files as one can carry, saying so
 * when pointed at.
 */
function AttachButton({
	full,
	onAttach,
}: {
	full: boolean;
	onAttach: ((files: File[]) => void) | undefined;
}) {
	const picker = useRef<HTMLInputElement>(null);
	const unavailable = full || onAttach === undefined;
	return (
		<>
			<input
				ref={picker}
				type="file"
				multiple
				hidden
				onChange={(event) => {
					const files = [...(event.currentTarget.files ?? [])];
					// Cleared, so choosing the same file again still counts as a change.
					event.currentTarget.value = "";
					if (files.length > 0) onAttach?.(files);
				}}
			/>
			<Tooltip
				label={
					full ? `${MAX_ATTACHMENTS_PER_MESSAGE} files is the most for one message` : "Attach files"
				}
				side="top"
			>
				<button
					type="button"
					aria-label="Attach files"
					aria-disabled={unavailable || undefined}
					onClick={() => {
						if (!unavailable) picker.current?.click();
					}}
					className={cn(toolButtonClassName, unavailable && "opacity-40 hover:bg-transparent")}
				>
					<Paperclip aria-hidden size={16} strokeWidth={2} />
				</button>
			</Tooltip>
		</>
	);
}

/** Beside Send: what holds the message back, else how full it is of files, else how to send it. */
function sendHint(items: readonly ComposerAttachment[]): string {
	const readiness = sendReadiness(items);
	if (!readiness.ready && readiness.failed > 0) {
		const action = items.some(({ upload }) => upload.state === "failed" && upload.retryable)
			? "Remove or retry"
			: "Remove";
		return readiness.failed === 1
			? `${action} the file that failed`
			: `${action} the ${readiness.failed} files that failed`;
	}
	if (!readiness.ready) {
		return readiness.uploading === 1
			? "1 file uploading"
			: `${readiness.uploading} files uploading`;
	}
	if (items.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
		return `${MAX_ATTACHMENTS_PER_MESSAGE} of ${MAX_ATTACHMENTS_PER_MESSAGE} files`;
	}
	return "Enter to send";
}

/**
 * The people and bots matching the mention being typed, floating over the
 * messages above the composer. The focus stays in the draft: arrow keys move
 * the highlight, which the draft points to as its active descendant.
 */
function MentionMenu({
	id,
	matches,
	selected,
	onHighlight,
	onChoose,
}: {
	id: string;
	matches: ThreadParticipant[];
	selected: number;
	onHighlight: (index: number) => void;
	onChoose: (participant: ThreadParticipant) => void;
}) {
	const list = useRef<HTMLDivElement>(null);
	// The focus is in the draft, not on the option, so the browser leaves the scrolling to us.
	useEffect(() => {
		list.current?.children[selected]?.scrollIntoView({ block: "nearest" });
	}, [selected]);
	return (
		<div className="absolute bottom-[calc(100%+6px)] left-1.5 z-20 w-[280px] max-w-[calc(100%-12px)] overflow-hidden rounded-lg border border-border-strong bg-panel text-foreground shadow-popover">
			<div className="px-3 pt-2.5 pb-1 font-medium text-subtle-foreground text-xs">Mention</div>
			<div
				ref={list}
				id={id}
				role="listbox"
				aria-label="People and bots to mention"
				className="max-h-60 overflow-y-auto p-1 pt-0"
			>
				{matches.map((participant, index) => (
					<button
						key={`${participant.kind}-${participant.id}`}
						id={`${id}-${index}`}
						type="button"
						role="option"
						tabIndex={-1}
						aria-selected={index === selected}
						// Keeps the focus, and so the cursor, in the draft.
						onMouseDown={(event) => event.preventDefault()}
						onMouseEnter={() => onHighlight(index)}
						onClick={() => onChoose(participant)}
						className="flex w-full items-center gap-2.5 rounded-tail px-2 py-[7px] text-left aria-selected:bg-chip"
					>
						{participant.kind === "agent" ? (
							<AgentAvatar
								color={participant.color}
								face={participant.face}
								shape={participant.shape}
								size={26}
							/>
						) : (
							<PersonAvatar person={participant} size={26} />
						)}
						<span className="flex min-w-0 flex-1 flex-col gap-px">
							<span className="truncate font-medium text-[14px]">{participant.name}</span>
							<span className="truncate text-muted-foreground text-xs">
								{participant.kind === "agent" ? "Bot" : `@${participant.handle}`}
							</span>
						</span>
					</button>
				))}
			</div>
		</div>
	);
}

/**
 * The mention the cursor is in: an `@` where the API would read one, and what
 * has been typed after it on the same line. Spaces are allowed, so a person can
 * type a name as it is written, but not straight after the `@`: in "meet @ noon"
 * the `@` means "at". It ends past any handle characters after the cursor, so
 * choosing someone with the cursor inside a handle replaces all of it.
 */
function mentionBeingTyped(value: string, cursor: number) {
	const typed = /@(?!\s)([^@\n]*)$/.exec(value.slice(0, cursor));
	if (!typed || !canStartMention(value, typed.index)) return undefined;
	const restOfHandle = /^[a-z0-9-]*/i.exec(value.slice(cursor))?.[0] ?? "";
	return { start: typed.index, end: cursor + restOfHandle.length, query: typed[1] ?? "" };
}

function matchesQuery(participant: ThreadParticipant, query: string): boolean {
	const lowered = query.toLocaleLowerCase();
	return (
		participant.name.toLocaleLowerCase().includes(lowered) || participant.handle.includes(lowered)
	);
}
