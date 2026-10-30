import { Popover } from "@base-ui/react/popover";
import {
	canStartMention,
	MAX_ATTACHMENTS_PER_MESSAGE,
	type MessageReplyTo,
	messageAuthorName,
	type ThreadParticipant,
} from "@sugabots/contracts";
import { type Emoji, emojiNamed, findByShortcode } from "@sugabots/emoji";
import { cn } from "cn";
import { ArrowUp, AtSign, Paperclip, Plus, Send, Smile, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
	type ComposerAttachment,
	type ComposerAttachments,
	canSend,
	sendReadiness,
} from "@/lib/composer-attachments.ts";
import { useAvailableEmoji } from "@/lib/emoji.ts";
import { rememberEmoji } from "@/lib/recent-emoji.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { EmojiPicker } from "@/ui/emoji-picker.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { AttachmentTray, LeftOutNote } from "./ComposerAttachments.tsx";
import { MentionEditor, type MentionEditorHandle } from "./MentionEditor.tsx";

/** A 30px icon button on the row beneath the draft, such as the paperclip, the @ and the smile. */
const toolButtonClassName =
	"focus-ring grid size-[30px] place-items-center rounded-tail text-muted-foreground transition-colors hover:bg-chip";

/**
 * Where a message is written: a box that grows with its text and sends on
 * Enter (Shift+Enter for a new line), with the paperclip, the @, the smile and
 * the send button on a row beneath the draft. The paperclip attaches files, as dropping
 * or pasting them does; they sit above the text as they upload. Send is off
 * until there is text or a file and every file has uploaded, and while
 * `sending`. Typing `@`, or pressing the @, offers everyone in `mentionable`
 * whose name or handle matches what follows it; choosing one writes their
 * handle into the draft, where it shows as a chip of their face and name.
 * Typing `:` and two letters of a shortcode, as in `:th`, offers the emoji it
 * names, and a shortcode closed with its colon, as `:thinking:`, becomes its
 * emoji. The smile opens a picker of every emoji and puts the one chosen at
 * the cursor. Either way it counts as a recent emoji in the picker; the emoji
 * load as the composer appears, so both have them at once. With `replyingTo`, a strip
 * over the draft names the message it answers; its × or Escape stops replying.
 */
export function ChatComposer({
	label,
	placeholder,
	model,
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
	/** Names the box for assistive technology, and is its placeholder unless `placeholder` says otherwise. */
	label: string;
	/** What the empty box says, when that is not its name. */
	placeholder?: string;
	/** The model of the bot the message goes to, named beside Send while nothing holds the message back. */
	model?: string;
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
	const menuId = `${id}-suggestions`;
	const editor = useRef<MentionEditorHandle>(null);
	const form = useRef<HTMLFormElement>(null);
	const [cursor, setCursor] = useState(value.length);
	const [activeSuggestion, setActiveSuggestion] = useState(0);
	/** Where the `@` or `:` of the menu that was closed is, so only that one stays closed. */
	const [dismissedMenuAt, setDismissedMenuAt] = useState<number>();
	const shortcodeTyped = shortcodeBeingTyped(value, cursor);
	const availableEmoji = useAvailableEmoji()?.emojis;
	const mentionTyped = mentionBeingTyped(value, cursor);
	const menu = openMenu(
		shortcodeTyped && availableEmoji
			? {
					kind: "emoji",
					typed: shortcodeTyped,
					matches: findByShortcode(availableEmoji, shortcodeTyped.query),
				}
			: mentionTyped && {
					kind: "mention",
					typed: mentionTyped,
					matches: mentionable.filter((candidate) => matchesQuery(candidate, mentionTyped.query)),
				},
		dismissedMenuAt,
	);
	const selectedSuggestion = menu ? Math.min(activeSuggestion, menu.matches.length - 1) : 0;

	// Choosing Reply on a message goes straight on to writing the reply.
	const replyingToId = replyingTo?.message.id;
	useEffect(() => {
		if (replyingToId) editor.current?.focus();
	}, [replyingToId]);

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		if (menu && !event.nativeEvent.isComposing) {
			const count = menu.matches.length;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				setActiveSuggestion((selectedSuggestion + step + count) % count);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setDismissedMenuAt(menu.typed.start);
				return;
			}
			// Shift+Enter still breaks the line, and Shift+Tab still moves the focus back.
			const unmodified = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
			if (unmodified && (event.key === "Enter" || event.key === "Tab")) {
				event.preventDefault();
				chooseSuggestion(menu, selectedSuggestion);
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

	function chooseSuggestion(open: SuggestionMenu, index: number): void {
		if (open.kind === "mention") {
			const participant = open.matches[index];
			if (participant) replaceTyped(open.typed, `@${participant.handle}`);
			return;
		}
		const emoji = open.matches[index];
		if (!emoji) return;
		replaceTyped(open.typed, emoji.emoji);
		rememberEmoji(emoji.emoji);
	}

	/** Writes `text` over the `@` or `:` and what follows it, then one space: the one already there, or a new one. */
	function replaceTyped(typed: TypedRange, text: string): void {
		const spaceAfter = value[typed.end] === " " ? 1 : 0;
		editor.current?.replace({ start: typed.start, end: typed.end + spaceAfter }, `${text} `);
	}

	/** Puts `emoji` at the cursor, as the smile's picker does. */
	function insertEmoji(emoji: string): void {
		const at = Math.min(cursor, value.length);
		editor.current?.replace({ start: at, end: at }, emoji);
	}

	/**
	 * Turns a shortcode just closed with its colon, as `:thinking:`, into its
	 * emoji. Says whether it did, as the draft is then reported again with it.
	 */
	function completeShortcode(next: string, caret: number): boolean {
		const closed = shortcodeClosed(next, caret);
		const named = closed && availableEmoji && emojiNamed(availableEmoji, closed.shortcode);
		if (!closed || !named) return false;
		editor.current?.replace(closed, named.emoji);
		rememberEmoji(named.emoji);
		return true;
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
			{menu?.kind === "mention" && (
				<SuggestionList
					id={menuId}
					title="Mention"
					label="People and bots to mention"
					items={menu.matches}
					keyOf={(participant) => `${participant.kind}-${participant.id}`}
					selected={selectedSuggestion}
					onHighlight={setActiveSuggestion}
					onChoose={(index) => chooseSuggestion(menu, index)}
				>
					{(participant) => <MentionOption participant={participant} />}
				</SuggestionList>
			)}
			{menu?.kind === "emoji" && (
				<SuggestionList
					id={menuId}
					title="Emoji"
					label="Emoji matching what was typed"
					items={menu.matches}
					keyOf={(emoji) => emoji.emoji}
					selected={selectedSuggestion}
					onHighlight={setActiveSuggestion}
					onChoose={(index) => chooseSuggestion(menu, index)}
				>
					{(emoji) => <EmojiOption emoji={emoji} />}
				</SuggestionList>
			)}
			{/*
			 * On a phone, one rounded line as a messaging app's is: attach, the
			 * draft, and Send, with what it replies to or carries above them.
			 * Mentions are typed, and the model is left to the bot's details.
			 * A tap anywhere on it but a control lands in the draft.
			 */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: only widens where a pointer reaches the draft, which the keyboard reaches directly. */}
			<div
				onClick={(event) => {
					if (!(event.target as Element).closest("button, a, input, [contenteditable]")) {
						editor.current?.focus();
					}
				}}
				className="focus-ring-within flex cursor-text flex-col rounded-xl border border-border-strong bg-panel transition-colors max-md:flex-row max-md:flex-wrap max-md:items-end max-md:gap-x-1 max-md:rounded-[23px] max-md:p-1"
			>
				<div className="flex flex-col max-md:w-full max-md:empty:hidden">
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
				</div>
				<div className="flex items-start gap-2.5 pt-2.5 pr-3 pb-1 pl-3 max-md:order-2 max-md:min-w-0 max-md:flex-1 max-md:px-1 max-md:py-1">
					<MentionEditor
						ref={editor}
						id={id}
						label={label}
						placeholder={placeholder}
						value={value}
						mentionable={mentionable}
						maxLength={20_000}
						onValueChange={(next, caret) => {
							if (completeShortcode(next, caret)) return;
							onValueChange(next);
							setCursor(caret);
							setActiveSuggestion(0);
							setDismissedMenuAt(undefined);
						}}
						onCaretChange={setCursor}
						onFocus={() => setDismissedMenuAt(undefined)}
						onBlur={() => setDismissedMenuAt(menu?.typed.start)}
						onKeyDown={handleKeyDown}
						onPaste={(event) => {
							const { files, types } = event.clipboardData;
							// Office apps put a picture of what was copied beside its text, which is what was meant.
							if (!attachments.attach || files.length === 0 || types.includes("text/plain")) return;
							event.preventDefault();
							attachments.attach([...files]);
						}}
						aria-controls={menu ? menuId : undefined}
						aria-activedescendant={menu ? `${menuId}-${selectedSuggestion}` : undefined}
					/>
				</div>
				<div className="flex items-center gap-0.5 px-1.5 pt-1 pb-1.5 max-md:contents">
					<AttachButton
						full={attachments.items.length >= MAX_ATTACHMENTS_PER_MESSAGE}
						onAttach={attachments.attach}
					/>
					<Tooltip label="Mention a bot or person" side="top">
						<button
							type="button"
							aria-label="Mention a bot or person"
							onClick={startMention}
							className={cn(toolButtonClassName, "max-md:hidden")}
						>
							<AtSign size={16} strokeWidth={2} />
						</button>
					</Tooltip>
					{/* A phone's own keyboard has emoji. */}
					<span className="contents max-md:hidden">
						<EmojiButton onChoose={insertEmoji} />
					</span>
					<span className="flex-1 max-md:hidden" />
					{/* Beside Send: what holds the message back, else the model that answers, else how to send it. */}
					{filesNote(attachments.items) === undefined && model ? (
						<span className="min-w-0 truncate pr-2 text-subtle-foreground text-xs max-md:hidden">
							{model}
						</span>
					) : (
						<span className="pr-2 text-subtle-foreground text-xs max-md:hidden [@media(hover:none)]:hidden">
							{filesNote(attachments.items) ?? "Enter to send"}
						</span>
					)}
					<button
						type="submit"
						aria-label={submitLabel}
						disabled={
							sending || !canSend(value, attachments.items) || (needsText && value.trim() === "")
						}
						className="focus-ring grid size-[30px] place-items-center rounded-[8px] bg-primary text-primary-foreground transition-colors hover:bg-primary-hover disabled:bg-chip-strong max-md:order-3 max-md:size-9 max-md:rounded-full"
					>
						<Send size={15} strokeWidth={2.2} className="max-md:hidden" />
						<ArrowUp size={18} strokeWidth={2.25} className="md:hidden" />
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
					className={cn(
						toolButtonClassName,
						"max-md:order-1 max-md:size-9 max-md:rounded-full",
						unavailable && "opacity-40 hover:bg-transparent",
					)}
				>
					<Paperclip aria-hidden size={16} strokeWidth={2} className="max-md:hidden" />
					<Plus aria-hidden size={20} strokeWidth={2} className="md:hidden" />
				</button>
			</Tooltip>
		</>
	);
}

/** What holds the message back, or how full it is of files, for beside Send; nothing when neither. */
function filesNote(items: readonly ComposerAttachment[]): string | undefined {
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
	return undefined;
}

/**
 * The smile, which opens the emoji picker over the draft. Choosing one puts it
 * at the cursor and goes back to writing; closing it without one goes back to
 * the smile.
 */
function EmojiButton({ onChoose }: { onChoose: (emoji: string) => void }) {
	const [open, setOpen] = useState(false);
	const chose = useRef(false);
	return (
		<Popover.Root
			open={open}
			onOpenChange={(next) => {
				if (next) chose.current = false;
				setOpen(next);
			}}
		>
			<Tooltip label="Add emoji" side="top">
				<Popover.Trigger aria-label="Add emoji" className={toolButtonClassName}>
					<Smile aria-hidden size={16} strokeWidth={2} />
				</Popover.Trigger>
			</Tooltip>
			<Popover.Portal>
				<Popover.Positioner
					side="top"
					align="start"
					sideOffset={6}
					collisionPadding={16}
					className="isolate z-50 outline-none"
				>
					<Popover.Popup
						aria-label="Add emoji"
						// Choosing one has already put the focus back in the draft.
						finalFocus={() => !chose.current}
						className="origin-(--transform-origin) overflow-hidden rounded-lg border border-border-strong bg-panel text-foreground shadow-popover outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95"
					>
						<EmojiPicker
							onSelect={(emoji) => {
								chose.current = true;
								setOpen(false);
								onChoose(emoji);
							}}
						/>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

/** Where an `@` or `:` was typed in the draft, and what follows it. */
interface TypedRange {
	start: number;
	end: number;
	query: string;
}

/** What the menu over the draft offers for what is being typed. */
type SuggestionMenu =
	| { kind: "mention"; typed: TypedRange; matches: readonly ThreadParticipant[] }
	| { kind: "emoji"; typed: TypedRange; matches: readonly Emoji[] };

/** The menu, unless it has nothing to offer or was closed where it was typed. */
function openMenu(
	menu: SuggestionMenu | undefined,
	dismissedAt: number | undefined,
): SuggestionMenu | undefined {
	if (!menu || menu.matches.length === 0 || menu.typed.start === dismissedAt) return undefined;
	return menu;
}

/**
 * What matches what is being typed, floating over the messages above the
 * composer. The focus stays in the draft: arrow keys move the highlight,
 * which the draft points to as its active descendant.
 */
function SuggestionList<Item>({
	id,
	title,
	label,
	items,
	keyOf,
	selected,
	onHighlight,
	onChoose,
	children: renderItem,
}: {
	id: string;
	title: string;
	label: string;
	items: readonly Item[];
	keyOf: (item: Item) => string;
	selected: number;
	onHighlight: (index: number) => void;
	onChoose: (index: number) => void;
	children: (item: Item) => ReactNode;
}) {
	const list = useRef<HTMLDivElement>(null);
	// The focus is in the draft, not on the option, so the browser leaves the scrolling to us.
	useEffect(() => {
		list.current?.children[selected]?.scrollIntoView({ block: "nearest" });
	}, [selected]);
	return (
		<div className="absolute bottom-[calc(100%+6px)] left-1.5 z-20 w-[280px] max-w-[calc(100%-12px)] overflow-hidden rounded-lg border border-border-strong bg-panel text-foreground shadow-popover">
			<div className="px-3 pt-2.5 pb-1 font-medium text-subtle-foreground text-xs">{title}</div>
			<div
				ref={list}
				id={id}
				role="listbox"
				aria-label={label}
				className="max-h-60 overflow-y-auto p-1 pt-0"
			>
				{items.map((item, index) => (
					<button
						key={keyOf(item)}
						id={`${id}-${index}`}
						type="button"
						role="option"
						tabIndex={-1}
						aria-selected={index === selected}
						// Keeps the focus, and so the cursor, in the draft.
						onMouseDown={(event) => event.preventDefault()}
						onMouseEnter={() => onHighlight(index)}
						onClick={() => onChoose(index)}
						className="flex w-full items-center gap-2.5 rounded-tail px-2 py-[7px] text-left aria-selected:bg-chip"
					>
						{renderItem(item)}
					</button>
				))}
			</div>
		</div>
	);
}

function MentionOption({ participant }: { participant: ThreadParticipant }) {
	return (
		<>
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
		</>
	);
}

function EmojiOption({ emoji }: { emoji: Emoji }) {
	return (
		<>
			<span aria-hidden className="grid size-[26px] place-items-center text-[20px] leading-none">
				{emoji.emoji}
			</span>
			<span className="min-w-0 flex-1 truncate text-[14px]">
				<span className="sr-only">{emoji.emoji} </span>:{emoji.shortcodes[0]}:
			</span>
		</>
	);
}

/** The characters of a shortcode, as `thinking`, `+1` or `flag-gb`. */
const SHORTCODE = "[a-z0-9_+-]";
/** How much of a shortcode is typed before emoji are offered, so `:)` and `:D` stay as they are. */
const MIN_SHORTCODE_TYPED = 2;

/**
 * The shortcode the cursor is in: a `:` at the start of a word, as a time
 * like 10:30 or a link's `://` is not, and at least two of a shortcode's
 * characters after it. It ends past any shortcode characters after the cursor.
 */
function shortcodeBeingTyped(value: string, cursor: number): TypedRange | undefined {
	const typed = new RegExp(`(?:^|[\\s(]):(${SHORTCODE}{${MIN_SHORTCODE_TYPED},})$`, "i").exec(
		value.slice(0, cursor),
	);
	const query = typed?.[1];
	if (!query) return undefined;
	const rest = new RegExp(`^${SHORTCODE}*`, "i").exec(value.slice(cursor))?.[0] ?? "";
	return { start: cursor - query.length - 1, end: cursor + rest.length, query };
}

/** A shortcode closed with its colon just before the cursor, as `:thinking:`. */
function shortcodeClosed(value: string, cursor: number) {
	const closed = new RegExp(`(?:^|[\\s(]):(${SHORTCODE}+):$`, "i").exec(value.slice(0, cursor));
	const shortcode = closed?.[1];
	if (!shortcode) return undefined;
	return { start: cursor - shortcode.length - 2, end: cursor, shortcode };
}

/**
 * The mention the cursor is in: an `@` where the API would read one, and what
 * has been typed after it on the same line. Spaces are allowed, so a person can
 * type a name as it is written, but not straight after the `@`: in "meet @ noon"
 * the `@` means "at". It ends past any handle characters after the cursor, so
 * choosing someone with the cursor inside a handle replaces all of it.
 */
function mentionBeingTyped(value: string, cursor: number): TypedRange | undefined {
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
