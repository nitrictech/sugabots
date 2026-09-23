import type { ThreadParticipant } from "@sugabots/contracts";
import { cn } from "cn";
import { AtSign, Plus, Send } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { Button } from "@/ui/button.tsx";

/** ChatComposer edits a controlled draft with participant mentions and keyboard submission. */
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
	mentionables = [],
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
	mentionables?: ThreadParticipant[];
}) {
	const id = useId();
	const mentionListId = `${id}-mentions`;
	const textarea = useRef<HTMLTextAreaElement>(null);
	const [cursor, setCursor] = useState(0);
	const [activeMention, setActiveMention] = useState(0);
	const [mentionDismissed, setMentionDismissed] = useState(false);
	const range = mentionRange(value, cursor);
	const matches = range
		? mentionables.filter(
				(participant) =>
					participant.name.toLocaleLowerCase().includes(range.query.toLocaleLowerCase()) ||
					participant.handle.includes(range.query.toLocaleLowerCase()),
			)
		: [];
	const mentionMenuOpen = !mentionDismissed && matches.length > 0;
	const selectedMentionIndex = Math.min(activeMention, matches.length - 1);

	function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
		if (mentionMenuOpen && event.key === "ArrowDown") {
			event.preventDefault();
			setActiveMention((current) => (current + 1) % matches.length);
			return;
		}
		if (mentionMenuOpen && event.key === "ArrowUp") {
			event.preventDefault();
			setActiveMention((current) => (current - 1 + matches.length) % matches.length);
			return;
		}
		if (mentionMenuOpen && event.key === "Escape") {
			event.preventDefault();
			setMentionDismissed(true);
			return;
		}
		if (mentionMenuOpen && (event.key === "Enter" || event.key === "Tab")) {
			event.preventDefault();
			selectMention(matches[selectedMentionIndex]);
			return;
		}
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		event.currentTarget.form?.requestSubmit();
	}

	function mention(): void {
		const input = textarea.current;
		if (!input) return;
		const start = input.selectionStart;
		onValueChange(`${value.slice(0, start)}@${value.slice(input.selectionEnd)}`);
		setCursor(start + 1);
		setActiveMention(0);
		setMentionDismissed(false);
		requestAnimationFrame(() => {
			input.focus();
			input.setSelectionRange(start + 1, start + 1);
		});
	}

	function selectMention(participant: ThreadParticipant | undefined): void {
		if (!participant || !range) return;
		const nextCursor = range.start + participant.handle.length + 2;
		onValueChange(`${value.slice(0, range.start)}@${participant.handle} ${value.slice(range.end)}`);
		setCursor(nextCursor);
		setMentionDismissed(true);
		requestAnimationFrame(() => {
			textarea.current?.focus();
			textarea.current?.setSelectionRange(nextCursor, nextCursor);
		});
	}

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				void onSubmit();
			}}
			className={cn("relative shrink-0", className)}
		>
			{mentionMenuOpen && (
				<div
					id={mentionListId}
					role="listbox"
					aria-label="People and agents in this thread"
					className="absolute inset-x-0 bottom-[calc(100%+8px)] z-20 overflow-hidden rounded-2xl border border-control-border bg-popover shadow-[0_14px_40px_rgba(40,35,30,0.14)]"
				>
					<div className="flex items-center justify-between border-border-subtle border-b px-4 py-2.5">
						<span className="font-semibold text-heading text-sm">Mention in this thread</span>
						<span className="text-2xs text-muted-foreground">↑↓ choose · Enter select</span>
					</div>
					<div className="max-h-56 overflow-y-auto p-1.5">
						{matches.map((participant, index) => (
							<button
								key={`${participant.kind}-${participant.id}`}
								id={`${mentionListId}-${index}`}
								type="button"
								role="option"
								aria-selected={index === selectedMentionIndex}
								onMouseDown={(event) => event.preventDefault()}
								onMouseEnter={() => setActiveMention(index)}
								onClick={() => selectMention(participant)}
								className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors data-[selected=true]:bg-primary-tint hover:bg-surface-accent"
								data-selected={index === selectedMentionIndex}
							>
								{participant.kind === "agent" ? (
									<AgentAvatar hue={participant.hue} face={participant.face} size={30} />
								) : (
									<PersonAvatar
										name={participant.name}
										email={participant.email}
										image={participant.image}
										size={30}
									/>
								)}
								<span className="min-w-0 flex-1">
									<span className="block truncate font-semibold text-heading text-base">
										{participant.name}
									</span>
									<span
										className={cn(
											"block text-xs",
											index === selectedMentionIndex
												? "text-primary-tint-foreground"
												: "text-muted-foreground",
										)}
									>
										{participant.kind === "agent" ? "Agent" : "Person"}
									</span>
								</span>
								<kbd className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
									@{participant.handle}
								</kbd>
							</button>
						))}
					</div>
				</div>
			)}
			<div className="focus-ring-within rounded-3xl border border-border-subtle bg-sunken px-[14px] pb-3 pt-[14px]">
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
						setMentionDismissed(false);
					}}
					onClick={(event) => setCursor(event.currentTarget.selectionStart)}
					onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
					onKeyDown={handleKeyDown}
					aria-autocomplete="list"
					aria-controls={mentionMenuOpen ? mentionListId : undefined}
					aria-activedescendant={
						mentionMenuOpen ? `${mentionListId}-${selectedMentionIndex}` : undefined
					}
					placeholder={placeholder}
					maxLength={20_000}
					rows={1}
					required
					className="mb-2.5 field-sizing-content block max-h-32 min-h-[26px] w-full resize-none bg-transparent px-1 py-0 text-xl leading-relaxed outline-none placeholder:text-muted-foreground"
				/>
				<div className="flex min-h-[38px] items-end gap-2">
					<button
						type="button"
						disabled
						aria-label="Add attachment"
						title="Attachments are not available yet"
						className="grid size-[34px] place-items-center rounded-xl bg-raised text-muted-foreground shadow-sm disabled:cursor-not-allowed"
					>
						<Plus size={17} />
					</button>
					<button
						type="button"
						onClick={mention}
						aria-label="Mention someone"
						className="focus-ring grid size-[34px] place-items-center rounded-xl bg-raised text-muted-foreground shadow-sm hover:text-heading"
					>
						<AtSign size={17} />
					</button>
					<div aria-live="polite" className="text-destructive text-sm">
						{error}
					</div>
					<Button
						type="submit"
						size="icon"
						aria-label={submitLabel}
						disabled={submitDisabled}
						className="ml-auto size-[38px] rounded-xl"
					>
						<Send size={17} />
					</Button>
				</div>
			</div>
		</form>
	);
}

function mentionRange(value: string, cursor: number) {
	const beforeCursor = value.slice(0, cursor);
	const start = beforeCursor.lastIndexOf("@");
	if (start < 0 || (start > 0 && !/\s/.test(value[start - 1] ?? ""))) return undefined;
	const query = beforeCursor.slice(start + 1);
	if (query.includes("\n")) return undefined;
	return { start, end: cursor, query };
}
