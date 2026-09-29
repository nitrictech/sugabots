import { canStartMention, type ThreadParticipant } from "@sugabots/contracts";
import { cn } from "cn";
import { ArrowUp, Plus } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";

/**
 * Where a message is written: a + for attachments, then a pill that grows with
 * its text and sends on Enter (Shift+Enter for a new line). The send button
 * takes the accent once there is something to send. Typing `@` offers everyone
 * in `mentionable` whose name or handle matches what follows it; choosing one
 * writes their handle into the draft.
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
			<div className="flex items-end gap-2.5">
				<button
					type="button"
					disabled
					aria-label="Add attachment"
					title="Attachments are not available yet"
					className="grid size-[38px] shrink-0 place-items-center rounded-full bg-chip text-soft-foreground disabled:cursor-not-allowed"
				>
					<Plus size={18} strokeWidth={2.2} />
				</button>
				<div className="focus-ring-within flex min-w-0 flex-1 items-end gap-2 rounded-composer border border-border-strong bg-panel py-1 pr-[5px] pl-4">
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
						className="field-sizing-content block max-h-40 min-h-9 min-w-0 flex-1 resize-none bg-transparent py-[7px] text-foreground text-lg leading-[22px] outline-none placeholder:text-subtle-foreground"
					/>
					<button
						type="submit"
						aria-label={submitLabel}
						disabled={submitDisabled}
						className={cn(
							"focus-ring mb-0.5 grid size-8 shrink-0 place-items-center rounded-full text-white transition-colors",
							value.trim() ? "bg-switch-on hover:bg-primary" : "bg-border-strong",
						)}
					>
						<ArrowUp size={16} strokeWidth={2.6} />
					</button>
				</div>
			</div>
			<div aria-live="polite" className="pl-12 text-destructive-text text-sm empty:hidden">
				{error}
			</div>
		</form>
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
