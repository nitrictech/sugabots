import {
	type BotParticipant,
	canStartMention,
	MAX_ATTACHMENTS_PER_MESSAGE,
	MESSAGE_MAX_LENGTH,
	type MessageReplyTo,
	messageAuthorName,
} from "@sugabots/contracts";
import { type Emoji, emojiNamed, findByShortcode } from "@sugabots/emoji";
import { cn } from "cn";
import { ArrowUp, AtSign, Paperclip, Plus, Square, X } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	type ComposerAttachment,
	type ComposerAttachments,
	canSend,
	sendReadiness,
} from "@/lib/composer-attachments.ts";
import { useAvailableEmoji } from "@/lib/emoji.ts";
import { matchesMedia, REDUCED_MOTION } from "@/lib/media.ts";
import { countOf } from "@/lib/name-list.ts";
import { rememberEmoji } from "@/lib/recent-emoji.ts";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { AttachmentTray, LeftOutNote } from "./ComposerAttachments.tsx";
import { MentionEditor, type MentionEditorHandle } from "./MentionEditor.tsx";
import { MentionChip, type MentionTarget, mentionTargetKey } from "./mentions.tsx";
import { ParticipantAvatar } from "./ParticipantAvatar.tsx";

/**
 * Whether the draft has run past a line, so it takes the whole width over its
 * buttons. Both ways it is the same test, the words'
 * width against the room the draft has beside the buttons, so it wraps and
 * unwraps at the same letter. A line break always wraps it.
 */
function useDraftWrapped(box: RefObject<HTMLDivElement | null>, value: string): boolean {
	const [wrapped, setWrapped] = useState(false);
	// Measured while it is beside the buttons, as it is wider once wrapped.
	const roomBeside = useRef<number>(undefined);
	useLayoutEffect(() => {
		const element = box.current;
		if (!element) return;
		const draft = element.querySelector("[contenteditable]");
		if (!wrapped && draft) roomBeside.current = draft.clientWidth;
		const room = roomBeside.current;
		const runsOver =
			value.includes("\n") ||
			(value !== "" && room !== undefined && textWidthIn(element, value) > room);
		setWrapped(runsOver);
	}, [box, value, wrapped]);
	return wrapped;
}

/** How the composer moves between one line and a wrapped draft. */
const RELAYOUT = { duration: 200, easing: "cubic-bezier(0.2, 0.6, 0.2, 1)" } as const;

/**
 * Moves the composer between one line and a wrapped draft rather than jumping:
 * its height eases to the new one, so it grows up from its foot, where + and
 * Send stay put, and the draft glides to where it now starts. A switch made
 * before the last has finished takes over from it, rather than adding to it.
 */
function useAnimatedRelayout(
	box: RefObject<HTMLDivElement | null>,
	draft: RefObject<HTMLDivElement | null>,
	wrapped: boolean,
) {
	// Measured from layout alone (offsets ignore a glide in progress), so switches can't add up.
	const before = useRef<{ height: number; draftLeft: number }>(undefined);
	const running = useRef<Animation[]>([]);
	// Declared first, so it reads where things were before this render's layout is recorded below.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the layout changes, not as each letter is typed; the refs are read as they stand then.
	useLayoutEffect(() => {
		const element = box.current;
		const draftElement = draft.current;
		const was = before.current;
		if (!element || !draftElement || !was) return;
		// Midway through the last switch, this one starts from where things are on screen.
		const midway = running.current.some((animation) => animation.playState === "running");
		const shownHeight = element.getBoundingClientRect().height;
		const shownDraftLeft = draftElement.getBoundingClientRect().left;
		for (const animation of running.current) animation.cancel();
		running.current = [];
		// Still under reduced motion, and where nothing animates, as in a test's DOM.
		const still = typeof element.animate !== "function" || matchesMedia(REDUCED_MOTION);
		if (still) return;
		const fromHeight = midway ? shownHeight : was.height;
		const shift = midway
			? shownDraftLeft - draftElement.getBoundingClientRect().left
			: was.draftLeft - draftElement.offsetLeft;
		running.current = [
			element.animate(
				[{ height: `${fromHeight}px` }, { height: `${element.offsetHeight}px` }],
				RELAYOUT,
			),
			draftElement.animate(
				[{ transform: `translateX(${shift}px)` }, { transform: "none" }],
				RELAYOUT,
			),
		];
	}, [wrapped]);
	useLayoutEffect(() => {
		const element = box.current;
		const draftElement = draft.current;
		if (!element || !draftElement) return;
		before.current = { height: element.offsetHeight, draftLeft: draftElement.offsetLeft };
	});
}

/** How wide `text` is on one line in the font of the draft inside `box`. */
function textWidthIn(box: HTMLElement, text: string): number {
	const draft = box.querySelector("[contenteditable]") ?? box;
	const context = document.createElement("canvas").getContext("2d");
	if (!context) return Number.POSITIVE_INFINITY;
	context.font = getComputedStyle(draft).font;
	return context.measureText(text).width;
}

/**
 * Where a message is written: one rounded line, as a messaging app's is, that
 * grows with its text and sends on Enter (Shift+Enter for a new line), with
 * + at its start and Send at its end. The + attaches files, as dropping or
 * pasting them does, or starts a mention; files sit above the text as they
 * upload. Send shows once there is something to send, and is off until every
 * file has uploaded, and while `sending` or `held`. Typing `@`, or choosing a mention
 * from the +, offers everyone in `mentionable` whose name or handle matches
 * what follows it; choosing one writes their handle into the draft, where it
 * shows as a chip of their face and name. Typing `:` and two letters of a
 * shortcode, as in `:th`, offers the emoji it names, and a shortcode closed
 * with its colon, as `:thinking:`, becomes its emoji, which counts as a recent
 * emoji in the picker; the emoji load as the composer appears. With `replyingTo`, a strip
 * over the draft names the message it answers, and with `addressed`, the bots the
 * message goes to. Each is a chip that is taken off by clicking it. Escape stops
 * the reply and takes off the bots inherited from the last message, but not
 * those the draft names, which stay as long as the draft names them.
 */
export function ChatComposer({
	label,
	placeholder,
	model,
	tall = false,
	value,
	onValueChange,
	onSubmit,
	submitLabel,
	sending = false,
	error,
	mentionable,
	replyingTo,
	addressed,
	attachments,
	notice,
	held,
	interrupt,
}: {
	/** Names the box for assistive technology, and is its placeholder unless `placeholder` says otherwise. */
	label: string;
	/** What the empty box says, when that is not its name. */
	placeholder?: string;
	/** The model of the bot the message goes to, shown by Send while nothing holds the message back. */
	model?: ReactNode;
	/** As a page's one box to start from, as a bot's page has it: the draft over its buttons, a few lines tall. */
	tall?: boolean;
	value: string;
	onValueChange: (value: string) => void;
	onSubmit: () => void | Promise<void>;
	submitLabel: string;
	/** A message is on its way, so another cannot be sent yet. */
	sending?: boolean;
	error?: ReactNode;
	/** Who the draft can mention, offered in this order. */
	mentionable: readonly MentionTarget[];
	/** The message the draft answers, quoted when it is sent. */
	replyingTo?: { message: MessageReplyTo; onCancel: () => void };
	/** The bots the message goes to, whether the draft names them or the last message did. */
	addressed?: {
		bots: readonly BotParticipant[];
		/** Takes one bot off, however it came to be addressed. */
		onRemove: (bot: BotParticipant) => void;
		/** Takes off the bots inherited from the last message, leaving those the draft names. */
		onClearInherited: () => void;
	};
	/**
	 * The files attached to the message, and what attaches, removes and
	 * retries them. Without them nothing can be attached, as before a chat
	 * starts, since a file uploads to its chat.
	 */
	attachments?: Pick<ComposerAttachments, "items" | "leftOut" | "attach" | "remove" | "retry">;
	/** A strip over everything else in the box, of what the member should know before sending, such as a connector bots can't use. */
	notice?: ReactNode;
	/**
	 * What holds the message back, as a bot it must go to having no model. It
	 * shows by Send in the model's place, on a phone too, and Send is off while
	 * there is one.
	 */
	held?: ReactNode;
	/**
	 * Stops the replies being written that the member may stop. While there is
	 * nothing to send, its button stands in Send's place.
	 */
	interrupt?: { label: string; pending: boolean; onInterrupt: () => void };
}) {
	const attachedFiles = attachments?.items ?? [];
	const id = useId();
	const menuId = `${id}-suggestions`;
	const editor = useRef<MentionEditorHandle>(null);
	const draftBox = useRef<HTMLDivElement>(null);
	// Tall, the draft always has the width over its buttons, with room for a few lines.
	const wrapped = useDraftWrapped(draftBox, value) || tall;
	const composerBox = useRef<HTMLDivElement>(null);
	useAnimatedRelayout(composerBox, draftBox, wrapped);
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
		const addressing = addressed && addressed.bots.length > 0;
		if ((replyingTo || addressing) && event.key === "Escape" && !event.nativeEvent.isComposing) {
			event.preventDefault();
			replyingTo?.onCancel();
			if (addressing) addressed.onClearInherited();
			return;
		}
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		form.current?.requestSubmit();
	}

	function chooseSuggestion(open: SuggestionMenu, index: number): void {
		if (open.kind === "mention") {
			const suggestion = open.matches[index];
			if (suggestion) replaceTyped(open.typed, `@${suggestion.handle}`);
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
				if (!held) void onSubmit();
			}}
			className="relative flex w-full shrink-0 flex-col"
		>
			{menu?.kind === "mention" && (
				<SuggestionList
					id={menuId}
					title="Mention"
					label="Who to mention"
					items={menu.matches}
					keyOf={mentionTargetKey}
					selected={selectedSuggestion}
					onHighlight={setActiveSuggestion}
					onChoose={(index) => chooseSuggestion(menu, index)}
				>
					{(suggestion) => <MentionOption suggestion={suggestion} />}
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
			 * One rounded line as a messaging app's is: +, the draft, and Send, with
			 * what it replies to or carries above them. Mentions and emoji are
			 * typed, and on a phone the model is left to the bot's details. A tap anywhere on it but a control
			 * lands in the draft.
			 */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: only widens where a pointer reaches the draft, which the keyboard reaches directly. */}
			<div
				ref={composerBox}
				onClick={(event) => {
					if (!(event.target as Element).closest("button, a, input, [contenteditable]")) {
						editor.current?.focus();
					}
				}}
				// Its lines sit at its foot (`content-end items-end`), so as it grows up + and Send stay put
				// and the draft is uncovered above them.
				className="focus-ring-within flex cursor-text flex-wrap content-end items-end gap-x-1 overflow-hidden rounded-composer border border-border-strong bg-composer p-1.5 transition-colors max-md:rounded-3xl max-md:p-1"
			>
				<div className="-mx-1.5 -mt-1.5 mb-1 flex grow basis-full flex-col empty:hidden max-md:-mx-1 max-md:-mt-1">
					{notice}
					{replyingTo && (
						<ReplyingToStrip message={replyingTo.message} onCancel={replyingTo.onCancel} />
					)}
					{addressed && addressed.bots.length > 0 && (
						<AddressedStrip bots={addressed.bots} onRemove={addressed.onRemove} />
					)}
					{attachments && (
						<>
							<AttachmentTray
								items={attachments.items}
								onRemove={attachments.remove}
								onRetry={attachments.retry}
								focusDraft={() => editor.current?.focus()}
							/>
							<LeftOutNote count={attachments.leftOut} />
						</>
					)}
				</div>
				<div
					ref={draftBox}
					className={cn(
						// On a phone it keeps its narrower padding however it grows.
						"order-2 flex min-w-0 flex-1 items-start px-1 py-px max-md:px-1 max-md:py-1",
						// Once it runs past a line, the draft has the whole width, over + and Send.
						wrapped && "order-0 basis-full px-1.5 pt-1 pb-1.5 max-md:flex-none",
						tall && "min-h-20 px-2.5 pt-2",
					)}
				>
					<MentionEditor
						ref={editor}
						id={id}
						label={label}
						placeholder={placeholder ?? label}
						value={value}
						mentionable={mentionable}
						maxLength={MESSAGE_MAX_LENGTH}
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
							if (!attachments || files.length === 0 || types.includes("text/plain")) return;
							event.preventDefault();
							attachments.attach([...files]);
						}}
						aria-controls={menu ? menuId : undefined}
						aria-activedescendant={menu ? `${menuId}-${selectedSuggestion}` : undefined}
					/>
				</div>
				<AttachButton
					full={attachedFiles.length >= MAX_ATTACHMENTS_PER_MESSAGE}
					onAttach={attachments?.attach}
					onMention={startMention}
				/>
				{value.trim() === "" && attachedFiles.length === 0 && interrupt && (
					<button
						type="button"
						aria-label={interrupt.label}
						disabled={interrupt.pending}
						onClick={interrupt.onInterrupt}
						className="focus-ring order-4 ml-auto grid size-7.5 shrink-0 place-items-center rounded-lg bg-destructive text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-60 max-md:order-3 max-md:size-9 max-md:rounded-full motion-safe:animate-rise"
					>
						<Square size={11} strokeWidth={0} fill="currentColor" className="max-md:size-3" />
					</button>
				)}
				{(value.trim() !== "" || attachedFiles.length > 0) && (
					<button
						type="submit"
						aria-label={submitLabel}
						disabled={!!held || sending || !canSend(value, attachedFiles)}
						className="focus-ring order-4 ml-auto grid size-7.5 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary-hover disabled:bg-chip-strong max-md:order-3 max-md:size-9 max-md:rounded-full motion-safe:animate-rise"
					>
						<ArrowUp size={16} strokeWidth={2.25} className="max-md:size-4.5" />
					</button>
				)}
			</div>
			<div className="flex items-start gap-3 px-1 pt-1.5 text-xs empty:hidden">
				<div aria-live="polite" className="min-w-0 flex-1 text-destructive-text empty:hidden">
					{error}
				</div>
				{held ? (
					<HeldNote>{held}</HeldNote>
				) : (
					<SendNote>{filesNote(attachedFiles) ?? model ?? "Enter to send"}</SendNote>
				)}
			</div>
		</form>
	);
}

/**
 * By Send: what is attached, else the model that answers, else how to send
 * it. A phone, with its own Send key, has none.
 */
function SendNote({ children }: { children: ReactNode }) {
	return (
		<span className="ml-auto min-w-0 truncate text-subtle-foreground text-xs max-md:hidden [@media(hover:none)]:hidden">
			{children}
		</span>
	);
}

/** By Send, in the model's place: why it is off. A phone shows it too, since nothing else says. */
function HeldNote({ children }: { children: ReactNode }) {
	return (
		<div className="ml-auto flex min-w-0 flex-col items-end gap-1 text-right text-muted-foreground text-xs">
			{children}
		</div>
	);
}

/**
 * A strip over the draft, one line high at least: what it replies to, whom it
 * goes to, or a notice about sending it. `className` adds to or overrides the
 * row's layout.
 */
export function ComposerStrip({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex min-h-9 items-center gap-1.5 border-border border-b px-3 py-1.5 text-muted-foreground text-xs",
				className,
			)}
		>
			{children}
		</div>
	);
}

/** Over the draft, the message it answers: its author, which stops the reply when clicked, and its first line. */
function ReplyingToStrip({ message, onCancel }: { message: MessageReplyTo; onCancel: () => void }) {
	const { author } = message;
	const name = messageAuthorName(author);
	return (
		<ComposerStrip>
			<span className="shrink-0">Replying to</span>
			{author.kind === "automation_trigger" ? (
				<span className="shrink-0 font-semibold text-soft-foreground">{name}</span>
			) : (
				<RemovableChip target={author} label={`Stop replying to ${name}`} onRemove={onCancel} />
			)}
			<span className="min-w-0 truncate">{message.preview}</span>
		</ComposerStrip>
	);
}

/** Over the draft, the bots it goes to, each taken off by clicking it. */
function AddressedStrip({
	bots,
	onRemove,
}: {
	bots: readonly BotParticipant[];
	onRemove: (bot: BotParticipant) => void;
}) {
	return (
		<ComposerStrip className="flex-wrap">
			<span className="shrink-0">To</span>
			{bots.map((bot) => (
				<RemovableChip
					key={bot.id}
					target={bot}
					label={`Stop sending to ${bot.name}`}
					onRemove={() => onRemove(bot)}
				/>
			))}
		</ComposerStrip>
	);
}

/** A mention chip that takes itself off when clicked, showing its × when pointed at. */
function RemovableChip({
	target,
	label,
	onRemove,
}: {
	target: MentionTarget;
	label: string;
	onRemove: () => void;
}) {
	return (
		<Tooltip label={label} side="top">
			<button
				type="button"
				aria-label={label}
				onClick={onRemove}
				className="group/chip focus-ring shrink-0 rounded-xs"
			>
				<MentionChip
					target={target}
					className="mx-0 items-center group-hover/chip:brightness-125"
					after={
						<X
							aria-hidden
							size={12}
							className="opacity-0 group-hover/chip:opacity-100 group-focus-visible/chip:opacity-100 max-md:opacity-100"
						/>
					}
				/>
			</button>
		</Tooltip>
	);
}

/**
 * The + at the start, opening a menu of what can be added: files, through the
 * system's file picker, or a mention. Upload is off until the chat exists, and
 * once the message has as many files as one can carry, saying so.
 */
function AttachButton({
	full,
	onAttach,
	onMention,
}: {
	full: boolean;
	onAttach: ((files: File[]) => void) | undefined;
	/** Starts a mention in the draft, from the + menu. */
	onMention: () => void;
}) {
	const picker = useRef<HTMLInputElement>(null);
	const unavailable = full || onAttach === undefined;
	// Run once the menu has closed, as closing gives focus back to the + and would take it from the draft.
	const afterClose = useRef<() => void>(undefined);
	const input = (
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
	);
	return (
		<>
			{input}
			<DropdownMenu
				onOpenChangeComplete={(open) => {
					if (open) return;
					afterClose.current?.();
					afterClose.current = undefined;
				}}
			>
				<IconButton
					label="Add"
					side="top"
					render={<DropdownMenuTrigger />}
					className="order-1 size-7.5 data-popup-open:bg-hover data-popup-open:text-foreground max-md:size-9 [&_svg]:size-4.5 max-md:[&_svg]:size-5"
				>
					<Plus aria-hidden strokeWidth={2} />
				</IconButton>
				<DropdownMenuContent side="top" align="start" className="min-w-56">
					<DropdownMenuItem
						disabled={unavailable}
						// Straight from the click, as a browser opens its file picker only in answer to one.
						onClick={() => picker.current?.click()}
					>
						<Paperclip aria-hidden size={16} />
						{full ? `${MAX_ATTACHMENTS_PER_MESSAGE} files is the most` : "Upload files"}
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							afterClose.current = onMention;
						}}
					>
						<AtSign aria-hidden size={16} />
						Mention a bot or member
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
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
	if (!readiness.ready) return `${countOf(readiness.uploading, "file", "files")} uploading`;
	if (items.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
		return `${MAX_ATTACHMENTS_PER_MESSAGE} of ${MAX_ATTACHMENTS_PER_MESSAGE} files`;
	}
	return undefined;
}

/** Where an `@` or `:` was typed in the draft, and what follows it. */
interface TypedRange {
	start: number;
	end: number;
	query: string;
}

/** What the menu over the draft offers for what is being typed. */
type SuggestionMenu =
	| { kind: "mention"; typed: TypedRange; matches: readonly MentionTarget[] }
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
		<div className="absolute bottom-full mb-1.5 left-1.5 z-20 w-70 max-w-composer-menu overflow-hidden rounded-lg border border-border-strong bg-panel text-foreground shadow-popover">
			<div className="px-3 pt-2.5 pb-1 font-medium text-subtle-foreground text-xs">{title}</div>
			<div
				ref={list}
				id={id}
				role="listbox"
				aria-label={label}
				className="max-h-72 overflow-y-auto p-1 pt-0"
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
						className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.75 text-left aria-selected:bg-chip"
					>
						{renderItem(item)}
					</button>
				))}
			</div>
		</div>
	);
}

function MentionOption({ suggestion }: { suggestion: MentionTarget }) {
	if (suggestion.kind === "group") {
		return (
			<>
				<span
					aria-hidden
					className="grid size-6.5 shrink-0 place-items-center rounded-full bg-chip text-muted-foreground"
				>
					<AtSign size={14} />
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-px">
					<span className="truncate font-medium text-sm">@{suggestion.handle}</span>
					<span className="truncate text-muted-foreground text-xs">
						Notifies {countOf(suggestion.notifies.length, "member", "members")}
					</span>
				</span>
			</>
		);
	}
	const participant = suggestion;
	return (
		<>
			<ParticipantAvatar participant={participant} size={26} />
			<span className="flex min-w-0 flex-1 flex-col gap-px">
				<span className="truncate font-medium text-sm">{participant.name}</span>
				<span className="truncate text-muted-foreground text-xs">
					{participant.kind === "bot" ? "Bot" : `@${participant.handle}`}
				</span>
			</span>
		</>
	);
}

function EmojiOption({ emoji }: { emoji: Emoji }) {
	return (
		<>
			<span aria-hidden className="grid size-6.5 place-items-center text-xl leading-none">
				{emoji.emoji}
			</span>
			<span className="min-w-0 flex-1 truncate text-sm">
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
 * has been typed after it on the same line. Spaces are allowed, so a member can
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

function matchesQuery(suggestion: MentionTarget, query: string): boolean {
	const lowered = query.toLocaleLowerCase();
	return (
		suggestion.handle.includes(lowered) ||
		(suggestion.kind !== "group" && suggestion.name.toLocaleLowerCase().includes(lowered))
	);
}
