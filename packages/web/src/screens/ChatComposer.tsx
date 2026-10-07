import {
	type AgentParticipant,
	canStartMention,
	type ThreadParticipant,
} from "@sugabots/contracts";
import { cn } from "cn";
import { AtSign, Send, UsersRound } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/**
 * Where a message is written: a box that grows with its text and sends on
 * Enter (Shift+Enter for a new line), with the @ and the send button on a row
 * beneath the draft. Typing `@`, or pressing the @, offers everyone in
 * `mentionable` whose name or handle matches what follows it; choosing one
 * writes their handle into the draft. With `peopleOnly`, a button beside the @
 * says whether the bot will answer, and it or Tab moves between writing to the bot,
 * the default, and writing to the other people only.
 */
export function ChatComposer({
	label,
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
	/** Names the box for assistive technology, and is its placeholder. */
	label: string;
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
		agent: Pick<AgentParticipant, "name">;
	};
}) {
	const id = useId();
	const mentionListId = `${id}-mentions`;
	const textarea = useRef<HTMLTextAreaElement>(null);
	const [cursor, setCursor] = useState(0);
	const [focused, setFocused] = useState(false);
	const [activeMention, setActiveMention] = useState(0);
	/** Where the `@` of the mention whose menu was closed is, so only that one stays closed. */
	const [dismissedMentionAt, setDismissedMentionAt] = useState<number>();
	const typing = mentionBeingTyped(value, cursor);
	const matches = typing
		? mentionable.filter((candidate) => matchesQuery(candidate, typing.query))
		: [];
	const mentionMenuOpen = typing?.start !== dismissedMentionAt && matches.length > 0;
	const selectedMention = Math.min(activeMention, matches.length - 1);
	const toPeople = peopleOnly?.on === true;

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

	/** Starts a mention at the cursor, as typing `@` would, so the same menu opens. */
	function startMention(): void {
		const draft = textarea.current;
		const at = draft?.selectionStart ?? value.length;
		// After a word, a space first: an `@` straight after a letter is an email address.
		const lead = at > 0 && !/\s/.test(value[at - 1] ?? "") ? " @" : "@";
		const nextCursor = at + lead.length;
		onValueChange(`${value.slice(0, at)}${lead}${value.slice(at)}`);
		setCursor(nextCursor);
		setDismissedMentionAt(undefined);
		requestAnimationFrame(() => {
			draft?.focus();
			draft?.setSelectionRange(nextCursor, nextCursor);
		});
	}

	return (
		<form
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
			<div
				className={cn(
					"focus-ring-within flex flex-col rounded-xl border bg-panel transition-colors",
					toPeople ? "border-people-only" : "border-border-strong",
				)}
			>
				<div className="flex items-start gap-2.5 pt-2.5 pr-3 pb-1 pl-3">
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
						onFocus={() => {
							setFocused(true);
							setDismissedMentionAt(undefined);
						}}
						onBlur={() => {
							setFocused(false);
							setDismissedMentionAt(typing?.start);
						}}
						onKeyDown={handleKeyDown}
						aria-autocomplete="list"
						aria-controls={mentionMenuOpen ? mentionListId : undefined}
						aria-activedescendant={
							mentionMenuOpen ? `${mentionListId}-${selectedMention}` : undefined
						}
						placeholder={label}
						maxLength={20_000}
						rows={1}
						className="field-sizing-content block max-h-40 min-h-7 min-w-0 flex-1 resize-none bg-transparent py-[3px] text-[15px] text-foreground leading-[22px] outline-none placeholder:text-subtle-foreground"
					/>
					{peopleOnly && focused && !value && (
						<span
							aria-hidden
							className="flex h-7 shrink-0 items-center gap-1.5 text-subtle-foreground text-xs [@media(hover:none)]:hidden"
						>
							<kbd className="rounded-[4px] border border-border-dashed px-[5px] py-px font-medium font-mono text-[11px] text-soft-foreground">
								Tab
							</kbd>
							{peopleOnly.on ? "back to bots" : "people only"}
						</span>
					)}
				</div>
				<div className="flex items-center gap-0.5 px-1.5 pt-1 pb-1.5">
					<Tooltip label="Mention a bot or person" side="top">
						<button
							type="button"
							aria-label="Mention a bot or person"
							onClick={startMention}
							className="focus-ring grid size-[30px] place-items-center rounded-tail text-muted-foreground transition-colors hover:bg-chip"
						>
							<AtSign size={16} strokeWidth={2} />
						</button>
					</Tooltip>
					{peopleOnly && (
						<AudienceChip
							agent={peopleOnly.agent}
							on={peopleOnly.on}
							onToggle={() => peopleOnly.onChange(!peopleOnly.on)}
						/>
					)}
					<span className="flex-1" />
					<span className="pr-2 text-subtle-foreground text-xs [@media(hover:none)]:hidden">
						Enter to send
					</span>
					<button
						type="submit"
						aria-label={submitLabel}
						disabled={submitDisabled}
						className={cn(
							"focus-ring grid size-[30px] place-items-center rounded-[8px] text-primary-foreground transition-colors disabled:bg-chip-strong",
							toPeople ? "bg-people-only-send" : "bg-primary hover:bg-primary-hover",
						)}
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

/**
 * Beside the @, the switch to writing to the people only: a quiet people icon
 * while the bot answers, and a "People only" chip while it won't. A click
 * switches, as Tab does from the draft.
 */
function AudienceChip({
	agent,
	on,
	onToggle,
}: {
	agent: Pick<AgentParticipant, "name">;
	on: boolean;
	onToggle: () => void;
}) {
	return (
		<Tooltip label={on ? `Message ${agent.name}` : "Message people only"} side="top">
			<button
				type="button"
				aria-pressed={on}
				aria-label="People only"
				onClick={onToggle}
				className={cn(
					"focus-ring flex shrink-0 items-center transition-colors",
					on
						? "ml-1 h-7 gap-[7px] rounded-[8px] bg-hover pr-2.5 pl-[9px] font-medium text-[13px] text-foreground"
						: "size-[30px] justify-center rounded-tail text-muted-foreground hover:bg-chip",
				)}
			>
				<UsersRound aria-hidden size={on ? 15 : 16} strokeWidth={2} className="shrink-0" />
				{on && <span>People only</span>}
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
							<AgentAvatar color={participant.color} face={participant.face} size={26} />
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
