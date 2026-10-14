import { Popover } from "@base-ui/react/popover";
import {
	MAX_REACTION_EMOJI_PER_MESSAGE,
	type Message,
	type MessageReaction,
	reactionEmojiSchema,
} from "@sugabots/contracts";
import { cn } from "cn";
import { Option, Schema } from "effect";
import { SmilePlus } from "lucide-react";
import { useState } from "react";
import { EmojiPicker } from "@/ui/emoji-picker.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/** How the person reading reacts to messages: who they are, so their own reactions show as theirs, and what changes them. */
export interface Reacting {
	userId: string;
	/** Adds the person's `emoji` to the message, or takes it back if they had it. */
	onToggle: (message: Message, emoji: string) => void;
	/** Adds the person's `emoji` to the message, unless they have it already. */
	onAdd: (message: Message, emoji: string) => void;
}

/**
 * The emoji people reacted to a message with, each with how many, in the order
 * they were first used. Yours are in the accent. Hovering one names who reacted
 * with it; clicking it adds yours or takes it back. After them, a button opens
 * the picker to add another. Without `reacting` they are only shown.
 */
export function MessageReactions({
	message,
	reacting,
	addable,
}: {
	message: Message;
	reacting: Reacting | undefined;
	/** Whether the message takes reactions yet, as one still being written or sent does not. */
	addable: boolean;
}) {
	const reactions = message.reactions ?? [];
	if (reactions.length === 0) return null;
	return (
		<ul aria-label="Reactions" className="m-0 flex list-none flex-wrap gap-1 p-0 pt-1.5">
			{reactions.map((reaction) => {
				const mine = reacting !== undefined && isAmong(reaction, reacting.userId);
				const who = whoReacted(reaction, reacting?.userId);
				const label = `${reaction.emoji} ${reaction.people.length}: ${who}`;
				const look = cn(
					"flex h-6 items-center gap-1 rounded-full border px-2 transition-colors",
					mine
						? "border-primary bg-reaction-mine text-reaction-mine-foreground"
						: "border-chip-strong bg-card text-soft-foreground",
				);
				const face = (
					<>
						<span aria-hidden className="text-[14px] leading-none">
							{reaction.emoji}
						</span>
						<span aria-hidden className="font-semibold text-xs tabular-nums">
							{reaction.people.length}
						</span>
					</>
				);
				return (
					<li key={reaction.emoji} className="flex">
						<Tooltip label={who} side="top">
							{reacting ? (
								<button
									type="button"
									aria-pressed={mine}
									aria-label={label}
									onClick={() => reacting.onToggle(message, reaction.emoji)}
									className={cn(
										"focus-ring cursor-pointer",
										look,
										!mine && "hover:border-border-dashed hover:bg-chip",
									)}
								>
									{face}
								</button>
							) : (
								<span className={look}>
									{face}
									<span className="sr-only">{label}</span>
								</span>
							)}
						</Tooltip>
					</li>
				);
			})}
			{reacting && addable && (
				<li className="flex">
					<AddReactionButton
						message={message}
						reacting={reacting}
						align="start"
						className="h-6 w-12 rounded-full border border-chip-strong text-muted-foreground hover:border-border-dashed hover:bg-chip hover:text-foreground [&_svg]:size-3.5"
					/>
				</li>
			)}
		</ul>
	);
}

/**
 * A button opening an emoji picker, in the hover toolbar and after a message's
 * reactions. Choosing one adds it and closes the picker. A message with as
 * many different emoji as it can take still takes one already on it.
 */
export function AddReactionButton({
	message,
	reacting,
	className,
	align = "end",
	onOpenChange,
}: {
	message: Message;
	reacting: Reacting;
	className: string;
	/** Which edge of the button the picker lines up with. */
	align?: "start" | "end";
	/** Whether the picker is open, as the toolbar stays up while it is. */
	onOpenChange?: (open: boolean) => void;
}) {
	const [open, setOpen] = useState(false);
	const used = new Set((message.reactions ?? []).map(({ emoji }) => emoji));
	const full = used.size >= MAX_REACTION_EMOJI_PER_MESSAGE;
	function changeOpen(next: boolean) {
		setOpen(next);
		onOpenChange?.(next);
	}
	function choose(chosen: string) {
		const decoded = decodeReactionEmoji(chosen);
		if (Option.isNone(decoded)) return;
		const emoji = decoded.value;
		if (full && !used.has(emoji)) return;
		reacting.onAdd(message, emoji);
		changeOpen(false);
	}
	return (
		<Popover.Root open={open} onOpenChange={changeOpen}>
			<Tooltip label="Add reaction" side="top">
				<Popover.Trigger
					aria-label="Add reaction"
					className={cn(
						"focus-ring grid shrink-0 cursor-pointer place-items-center transition-colors [&_svg]:pointer-events-none",
						className,
					)}
				>
					<SmilePlus aria-hidden />
				</Popover.Trigger>
			</Tooltip>
			<Popover.Portal>
				<Popover.Positioner
					side="top"
					align={align}
					sideOffset={6}
					collisionPadding={16}
					className="isolate z-50 outline-none"
				>
					<Popover.Popup
						aria-label="Add reaction"
						className="origin-(--transform-origin) overflow-hidden rounded-lg border border-border-strong bg-panel text-foreground shadow-popover outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95"
					>
						{full && (
							<p className="m-0 max-w-[332px] border-border-strong border-b px-3 py-2 text-muted-foreground text-sm">
								This message has {MAX_REACTION_EMOJI_PER_MESSAGE} different reactions, the most it
								can have. You can still add one of those.
							</p>
						)}
						<EmojiPicker onSelect={choose} />
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

/**
 * An emoji the picker gave, as a reaction reads it. Every emoji the picker
 * offers decodes, which the contracts' tests hold it to.
 */
const decodeReactionEmoji = Schema.decodeUnknownOption(reactionEmojiSchema);

function isAmong(reaction: MessageReaction, userId: string): boolean {
	return reaction.people.some((person) => person.id === userId);
}

/** How many people a reaction's tooltip names before it counts the rest. */
const MAX_NAMED = 10;

/** For example "You, Sam and Reviewer reacted with 👍", or "… and 4 others reacted with 👍". */
function whoReacted(reaction: MessageReaction, userId: string | undefined): string {
	const names = reaction.people.map((person) => (person.id === userId ? "You" : person.name));
	const named = names.length > MAX_NAMED ? names.slice(0, MAX_NAMED - 1) : names;
	const others = names.length - named.length;
	const list = others > 0 ? [...named, `${others} others`] : named;
	return `${conjunction.format(list)} reacted with ${reaction.emoji}`;
}

const conjunction = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
