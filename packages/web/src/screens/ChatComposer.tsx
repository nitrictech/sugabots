import {
	type AgentParticipant,
	canStartMention,
	type ThreadParticipant,
} from "@sugabots/contracts";
import { cn } from "cn";
import { ArrowUp, Plus, UsersRound } from "lucide-react";
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
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/**
 * Where a message is written: a pill that grows with its text and sends on
 * Enter (Shift+Enter for a new line). A one-line draft sits between the + for
 * attachments and the send button; a longer one takes the pill's full width,
 * with the buttons on a row beneath it. The send button takes the accent once
 * there is something to send. Typing `@` offers everyone in `mentionable` whose
 * name or handle matches what follows it; choosing one writes their handle into
 * the draft. With `peopleOnly`, a toggle beside the +, or Tab, switches between
 * writing to the bot and writing to the other people only.
 */
export function ChatComposer({
	label,
	placeholder,
	value,
	onValueChange,
	onSubmit,
	submitLabel,
	submitDisabled,
	error,
	className,
	mentionable,
	peopleOnly,
}: {
	label: string;
	placeholder: string;
	value: string;
	onValueChange: (value: string) => void;
	onSubmit: () => void | Promise<void>;
	submitLabel: string;
	submitDisabled: boolean;
	error?: ReactNode;
	className?: string;
	/** Who the draft can mention. */
	mentionable: ThreadParticipant[];
	/** Offered when other people are in the thread, to write to them without the bot replying. */
	peopleOnly?: {
		on: boolean;
		onChange: (on: boolean) => void;
		/** The bot that replies unless the message is for people only. */
		agent: Pick<AgentParticipant, "name" | "color" | "face">;
	};
}) {
	const id = useId();
	const mentionListId = `${id}-mentions`;
	const textarea = useRef<HTMLTextAreaElement>(null);
	const [cursor, setCursor] = useState(0);
	const [activeMention, setActiveMention] = useState(0);
	/** Where the `@` of the mention whose menu was closed is, so only that one stays closed. */
	const [dismissedMentionAt, setDismissedMentionAt] = useState<number>();
	const typing = mentionBeingTyped(value, cursor);
	const matches = typing
		? mentionable.filter((candidate) => matchesQuery(candidate, typing.query))
		: [];
	const mentionMenuOpen = typing?.start !== dismissedMentionAt && matches.length > 0;
	const selectedMention = Math.min(activeMention, matches.length - 1);
	const pill = useRef<HTMLDivElement>(null);
	const stacked = useStackedDraft(pill, textarea, value);

	// A draft kept from an earlier visit is picked up at its end, not before its first word.
	useEffect(() => {
		const end = textarea.current?.value.length ?? 0;
		textarea.current?.setSelectionRange(end, end);
	}, []);

	function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
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
		// Shift+Tab still moves the focus back.
		if (peopleOnly && event.key === "Tab" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			peopleOnly.onChange(!peopleOnly.on);
			return;
		}
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		event.currentTarget.form?.requestSubmit();
	}

	function insertMention(participant: ThreadParticipant | undefined): void {
		if (!participant || !typing) return;
		const after = value.slice(typing.end);
		// One space after the handle: the one already there, or a new one.
		const mention = /^\s/.test(after) ? `@${participant.handle}` : `@${participant.handle} `;
		const nextCursor = typing.start + `@${participant.handle} `.length;
		onValueChange(`${value.slice(0, typing.start)}${mention}${after}`);
		setCursor(nextCursor);
		requestAnimationFrame(() => textarea.current?.setSelectionRange(nextCursor, nextCursor));
	}

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				void onSubmit();
			}}
			className={cn("relative flex shrink-0 flex-col gap-1.5", className)}
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
			<div
				ref={pill}
				className={cn(
					"focus-ring-within grid items-end gap-x-2 rounded-composer border border-border-strong bg-panel px-1.25 py-1",
					peopleOnly
						? cn(
								"grid-cols-[auto_auto_minmax(0,1fr)_auto_auto]",
								stacked
									? "[grid-template-areas:'draft_draft_draft_draft_draft'_'attach_audience_._hint_send']"
									: "[grid-template-areas:'attach_audience_draft_hint_send']",
							)
						: cn(
								"grid-cols-[auto_minmax(0,1fr)_auto]",
								stacked
									? "[grid-template-areas:'draft_draft_draft'_'attach_._send']"
									: "[grid-template-areas:'attach_draft_send']",
							),
				)}
			>
				{/* Not `disabled`: a disabled button gets no hover or focus, so its tooltip would never open. */}
				<IconButton
					label="Attach files (coming soon)"
					side="top"
					aria-disabled
					className="mb-0.5 size-8 [grid-area:attach] aria-disabled:cursor-default aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground [&_svg]:size-4.5"
				>
					<Plus strokeWidth={2.2} />
				</IconButton>
				{peopleOnly && (
					<AudienceToggle {...peopleOnly} onToggle={() => peopleOnly.onChange(!peopleOnly.on)} />
				)}
				<label htmlFor={id} className="sr-only">
					{label}
				</label>
				<textarea
					ref={textarea}
					id={id}
					value={value}
					onChange={(event) => {
						onValueChange(event.target.value);
						setCursor(event.target.selectionStart);
						setActiveMention(0);
						setDismissedMentionAt(undefined);
					}}
					onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
					onFocus={() => setDismissedMentionAt(undefined)}
					onBlur={() => setDismissedMentionAt(typing?.start)}
					onKeyDown={handleKeyDown}
					aria-autocomplete="list"
					aria-controls={mentionMenuOpen ? mentionListId : undefined}
					aria-activedescendant={
						mentionMenuOpen ? `${mentionListId}-${selectedMention}` : undefined
					}
					placeholder={placeholder}
					maxLength={20_000}
					rows={1}
					required
					className={cn(
						"field-sizing-content block max-h-40 min-h-9 min-w-0 resize-none bg-transparent py-[7px] text-foreground text-lg leading-[22px] outline-none [grid-area:draft] placeholder:text-subtle-foreground",
						// In line with the + below it.
						stacked && "px-1.75",
					)}
				/>
				{peopleOnly && (
					// A touch screen has no Tab key; the toggle is how it switches.
					<span
						aria-hidden
						className="mb-2 flex shrink-0 items-center gap-1.5 whitespace-nowrap text-subtle-foreground text-xs [grid-area:hint] max-sm:hidden [@media(hover:none)]:hidden"
					>
						<kbd className="rounded-[5px] border border-border-strong px-1.5 py-px font-sans font-semibold text-[11px] text-muted-foreground">
							Tab
						</kbd>
						{peopleOnly.on ? "back to bots" : "people only"}
					</span>
				)}
				<button
					type="submit"
					aria-label={submitLabel}
					disabled={submitDisabled}
					className={cn(
						"focus-ring mb-0.5 grid size-8 place-items-center rounded-full text-white transition-colors [grid-area:send]",
						value.trim() ? "bg-switch-on hover:bg-primary" : "bg-border-strong",
					)}
				>
					<ArrowUp size={16} strokeWidth={2.6} />
				</button>
			</div>
			<div aria-live="polite" className="pl-3 text-destructive-text text-sm empty:hidden">
				{error}
			</div>
		</form>
	);
}

/**
 * Whether the draft takes the pill's full width above the buttons: once it has
 * a line break or wraps beside them. An empty draft never does, even when its
 * placeholder wraps. Measuring while stacked would read the wider row and flip
 * straight back, so a stacked draft stays stacked until it gets shorter or the
 * pill changes width, and is then measured inline again. Typing re-measures
 * before paint, so the layout never visibly flickers.
 */
function useStackedDraft(
	pill: RefObject<HTMLElement | null>,
	textarea: RefObject<HTMLTextAreaElement | null>,
	value: string,
): boolean {
	/** The pill's width as last observed; a change measures the draft again. */
	const [observedPillWidth, setObservedPillWidth] = useState<number>();
	const [stackedAt, setStackedAt] = useState<{ draftLength: number; pillWidth: number }>();

	useEffect(() => {
		const element = pill.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setObservedPillWidth(element.clientWidth));
		observer.observe(element);
		return () => observer.disconnect();
	}, [pill]);

	useLayoutEffect(() => {
		const pillElement = pill.current;
		const draft = textarea.current;
		if (!pillElement || !draft) return;
		if (!stackedAt) {
			const outgrowsRow = value !== "" && (value.includes("\n") || wrapsPastOneLine(draft));
			if (!outgrowsRow) return;
			// The observed width, as that is what it is compared with below. The observer's
			// update can lag the DOM, so a live width would never match and the layout would
			// flip between stacked and inline forever.
			const pillWidth = observedPillWidth ?? pillElement.clientWidth;
			setStackedAt({ draftLength: value.length, pillWidth });
			return;
		}
		const resized = observedPillWidth !== undefined && observedPillWidth !== stackedAt.pillWidth;
		const mightFitInline = value.length < stackedAt.draftLength || resized;
		if (!value.includes("\n") && mightFitInline) setStackedAt(undefined);
	}, [pill, textarea, value, observedPillWidth, stackedAt]);

	return stackedAt !== undefined;
}

function wrapsPastOneLine(textarea: HTMLTextAreaElement): boolean {
	const style = getComputedStyle(textarea);
	const oneLine =
		Number.parseFloat(style.lineHeight) +
		Number.parseFloat(style.paddingTop) +
		Number.parseFloat(style.paddingBottom);
	return textarea.scrollHeight > oneLine;
}

/**
 * Who the message is for, beside the +: the bot's face while it
 * replies, and a "People only" chip while it only reads along.
 */
function AudienceToggle({
	on,
	agent,
	onToggle,
}: {
	on: boolean;
	agent: Pick<AgentParticipant, "name" | "color" | "face">;
	onToggle: () => void;
}) {
	const label = on ? (
		<>
			<span className="block font-semibold">People only</span>
			{agent.name} reads along but won't reply. Tab to switch back.
		</>
	) : (
		<>
			<span className="block font-semibold">{agent.name} replies</span>
			Tab or click to message people only.
		</>
	);
	return (
		<Tooltip label={label} side="top">
			<button
				type="button"
				aria-pressed={on}
				aria-label="People only"
				onClick={onToggle}
				className={cn(
					"focus-ring mb-0.5 flex h-8 shrink-0 items-center rounded-full transition-colors [grid-area:audience]",
					on
						? "gap-1.5 border border-border-strong bg-chip px-2.5 font-semibold text-foreground text-sm hover:bg-hover"
						: "w-8 justify-center hover:bg-hover",
				)}
			>
				{on ? (
					<>
						<UsersRound size={15} strokeWidth={2.2} />
						People only
					</>
				) : (
					<AgentAvatar color={agent.color} face={agent.face} size={22} />
				)}
			</button>
		</Tooltip>
	);
}

/**
 * The people and bots matching the mention being typed, floating over the
 * messages above the composer. The focus stays in the draft: arrow keys move
 * the highlight, which the textarea points to as its active descendant.
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
		<div className="absolute inset-x-0 bottom-[calc(100%+8px)] z-20 overflow-hidden rounded-panel bg-panel text-foreground shadow-dialog">
			<div className="flex items-center justify-between gap-3 px-4 pt-3 pb-1.5 text-xs">
				<span className="font-semibold text-subtle-foreground">Mention</span>
				<span aria-hidden className="text-subtle-foreground">
					↑↓ to choose · Enter to select
				</span>
			</div>
			<div
				ref={list}
				id={id}
				role="listbox"
				aria-label="People and bots to mention"
				className="max-h-60 overflow-y-auto p-1.5 pt-0"
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
						className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14.5px] aria-selected:bg-hover"
					>
						{participant.kind === "agent" ? (
							<AgentAvatar color={participant.color} face={participant.face} size={28} />
						) : (
							<PersonAvatar name={participant.name} image={participant.image} size={28} />
						)}
						<span className="min-w-0 flex-1 truncate font-medium">{participant.name}</span>
						<span className="shrink-0 text-muted-foreground text-sm">@{participant.handle}</span>
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
