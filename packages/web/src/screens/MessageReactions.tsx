import {
	MAX_REACTION_EMOJI_PER_MESSAGE,
	type Message,
	type MessageReaction,
	reactionEmojiSchema,
} from "@sugabots/contracts";
import { cn } from "cn";
import { Option, Schema } from "effect";
import { SmilePlus } from "lucide-react";
import { listNames } from "@/lib/name-list.ts";
import { EmojiPickerPopover } from "@/ui/emoji-picker-popover.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/** How the member reading reacts to messages: who they are, so their own reactions show as theirs, and what changes them. */
export interface Reacting {
	memberId: string;
	/** Adds the member's `emoji` to the message, or takes it back if they had it. */
	onToggle: (message: Message, emoji: string) => void;
	/** Adds the member's `emoji` to the message, unless they have it already. */
	onAdd: (message: Message, emoji: string) => void;
}

/**
 * The emoji members reacted to a message with, each with how many, in the order
 * they were first used, as filled pills, yours shaded apart. Hovering one
 * names who reacted with it; clicking it adds yours or takes it back. Another
 * is added from the message's toolbar. Without `reacting` they are only shown.
 */
export function MessageReactions({
	message,
	reacting,
}: {
	message: Message;
	reacting: Reacting | undefined;
}) {
	const reactions = message.reactions ?? [];
	if (reactions.length === 0) return null;
	return (
		<ul aria-label="Reactions" className="m-0 flex list-none flex-wrap gap-1 p-0">
			{reactions.map((reaction) => {
				const mine = reacting !== undefined && isAmong(reaction, reacting.memberId);
				const who = whoReacted(reaction, reacting?.memberId);
				const count = reactorsOf(reaction).length;
				const label = `${reaction.emoji} ${count}: ${who}`;
				const pill = cn(
					"flex h-6 items-center gap-1 rounded-full px-2 transition-colors",
					mine ? "bg-reaction-mine text-reaction-mine-foreground" : "bg-chip text-soft-foreground",
				);
				const face = (
					<>
						<span aria-hidden className="text-sm leading-none">
							{reaction.emoji}
						</span>
						<span aria-hidden className="font-semibold text-xs tabular-nums">
							{count}
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
									className={cn("focus-ring cursor-pointer", pill, !mine && "hover:bg-hover")}
								>
									{face}
								</button>
							) : (
								<span className={pill}>
									{face}
									<span className="sr-only">{label}</span>
								</span>
							)}
						</Tooltip>
					</li>
				);
			})}
		</ul>
	);
}

/**
 * The smile in a message's toolbar, opening an emoji picker. Choosing one adds
 * it and closes the picker. A message with as many different emoji as it can
 * take still takes one already on it.
 */
export function AddReactionButton({
	message,
	reacting,
	onOpenChange,
}: {
	message: Message;
	reacting: Reacting;
	/** Whether the picker is open, as the toolbar stays up while it is. */
	onOpenChange: (open: boolean) => void;
}) {
	const used = new Set((message.reactions ?? []).map(({ emoji }) => emoji));
	const full = used.size >= MAX_REACTION_EMOJI_PER_MESSAGE;
	function choose(chosen: string): boolean {
		const decoded = decodeReactionEmoji(chosen);
		if (Option.isNone(decoded)) return false;
		const emoji = decoded.value;
		if (full && !used.has(emoji)) return false;
		reacting.onAdd(message, emoji);
		return true;
	}
	return (
		<EmojiPickerPopover
			label="Add reaction"
			trigger={
				<IconButton label="Add reaction" side="top" variant="toolbar">
					<SmilePlus aria-hidden />
				</IconButton>
			}
			header={
				full && (
					<p className="m-0 max-w-80 border-border-strong border-b px-3 py-2 text-muted-foreground text-xs">
						This message has {MAX_REACTION_EMOJI_PER_MESSAGE} different reactions, the most it can
						have. You can still add one of those.
					</p>
				)
			}
			onOpenChange={onOpenChange}
			onSelect={choose}
		/>
	);
}

/**
 * An emoji the picker gave, as a reaction reads it. Every emoji the picker
 * offers decodes, which the contracts' tests hold it to.
 */
const decodeReactionEmoji = Schema.decodeUnknownOption(reactionEmojiSchema);

function isAmong(reaction: MessageReaction, memberId: string): boolean {
	return reaction.members.some((member) => member.id === memberId);
}

/** How many members a reaction's tooltip names before it counts the rest. */
const MAX_NAMED = 10;

/** Who reacted with the emoji, members first, then the bots that did, as a bot reads with 👀 what it chose not to answer. */
function reactorsOf(reaction: MessageReaction): MessageReaction["members"] {
	return [...reaction.members, ...(reaction.bots ?? [])];
}

/** For example "You, Sam and Reviewer reacted with 👍", or "… and 4 others reacted with 👍". */
function whoReacted(reaction: MessageReaction, memberId: string | undefined): string {
	const names = reactorsOf(reaction).map((reactor) =>
		reactor.id === memberId ? "You" : reactor.name,
	);
	return `${listNames(names, { maxNamed: MAX_NAMED })} reacted with ${reaction.emoji}`;
}
