import {
	type AgentParticipant,
	GROUP_MENTION_HANDLES,
	type GroupMentionHandle,
	type MessageAuthor,
	mentionedHandles,
	NOTIFYING_THREAD_TYPES,
	type PersonParticipant,
	splitAroundMentions,
	type ThreadDetails,
	type ThreadParticipant,
	type ThreadType,
} from "@sugabots/contracts";
import { cn } from "cn";
import type { PhrasingContent, Root } from "mdast";
import { type ComponentProps, createContext, type ReactNode, useContext, useState } from "react";
import type { ExtraProps } from "streamdown";
import type { Plugin } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { MentionCard } from "./MentionCard.tsx";

/*
 * `@handle` in a message, drawn as a chip for whoever it names. Markdown text
 * nodes are split with the parser the API routes by, so a mention inside a
 * list item or a bold run is still a mention while one inside a code span,
 * its own node type, is left alone, as is one in a link's address. The API
 * reads the raw text, code and addresses included, so a mention in either
 * still reaches whoever it names without a chip.
 */

/**
 * Everyone a mention in the thread can name: those in it, then the pod's bots
 * and people who are not.
 */
export function mentionableIn(
	details: Pick<ThreadDetails, "participants" | "crew" | "members">,
): ThreadParticipant[] {
	const joined = new Set(details.participants.map(({ id }) => id));
	return [
		...details.participants,
		...details.crew.filter(({ id }) => !joined.has(id)),
		...details.members.filter(({ id }) => !joined.has(id)),
	];
}

/** The bots among `crew` that `draft` names, each once, in the order it first names them. */
export function botsNamed(draft: string, crew: readonly ThreadParticipant[]): AgentParticipant[] {
	const bots = crew.filter((member): member is AgentParticipant => member.kind === "agent");
	const handles = new Set(mentionedHandles(draft));
	return [...handles].flatMap((handle) => bots.filter((bot) => bot.handle === handle));
}

/**
 * The bot named first in `draft` among `crew`, which sending a new thread's
 * first message starts it with; any named after it are only mentioned.
 */
export function firstBotNamed(
	draft: string,
	crew: readonly ThreadParticipant[],
): AgentParticipant | undefined {
	return botsNamed(draft, crew).at(0);
}

/** `@here` or `@channel`, which a person writes to notify everyone who can see the conversation. */
export interface GroupMention {
	kind: "group";
	handle: GroupMentionHandle;
	/**
	 * The people it would notify: the pod's people but its writer, never a bot.
	 * Each one's own notification settings can still hold theirs back.
	 */
	notifies: readonly PersonParticipant[];
}

/** Whom a mention can name: a person or a bot, or with `@here` or `@channel`, everyone. */
export type MentionTarget = ThreadParticipant | GroupMention;

/** Who writes a message, as far as `@here` and `@channel` care: a person, by id, or not a person. */
type Writer = { kind: "person"; id: string } | { kind: Exclude<MessageAuthor["kind"], "person"> };

/**
 * `@here` and `@channel` as `writer` can use them in a thread of `threadType`,
 * each notifying `members`, the pod's people, but the writer. None where they
 * would notify nobody, so they stay text: written by a bot or a routine, in a
 * thread that notifies nobody, or in a pod with nobody else in it. None in a
 * direct message either, where everybody in it is told of every message.
 */
export function groupMentionsBy(
	writer: Writer,
	members: readonly PersonParticipant[],
	threadType: ThreadType,
): GroupMention[] {
	if (writer.kind !== "person" || !NOTIFYING_THREAD_TYPES.has(threadType)) return [];
	if (threadType === "direct") return [];
	const notifies = members.filter((member) => member.id !== writer.id);
	if (notifies.length === 0) return [];
	return GROUP_MENTION_HANDLES.map((handle) => ({ kind: "group", handle, notifies }));
}

/**
 * Whom the handle `handle`, as a mention writes it, names among `mentionable`.
 * A person whose handle is `here` or `channel` is mentioned with everyone else.
 */
export function targetWithHandle(
	mentionable: readonly MentionTarget[],
	handle: string,
): MentionTarget | undefined {
	const lowered = handle.toLowerCase();
	return (
		mentionable.find((candidate) => candidate.kind === "group" && candidate.handle === lowered) ??
		mentionable.find((candidate) => candidate.handle === lowered)
	);
}

/** What tells `target` apart from the others in a list of them. */
export function mentionTargetKey(target: MentionTarget): string {
	return target.kind === "group" ? target.handle : `${target.kind}-${target.id}`;
}

/**
 * A mention as a chip that stands off the words around it: a bot by its face
 * and name, a person or everyone by the handle. Sent messages and the composer
 * both draw it, so a mention looks the same before and after it is sent, and
 * both open its `MentionCard` from it.
 */
export function MentionChip({
	target,
	after,
	className,
	...rest
}: {
	target: MentionTarget;
	/** Shown after the name, inside the chip, such as a × that removes it. */
	after?: ReactNode;
} & ComponentProps<"span">) {
	return (
		<span
			{...rest}
			className={cn(
				"focus-ring mx-px inline-flex cursor-pointer items-baseline gap-1 rounded-xs bg-chip px-1 font-semibold text-foreground leading-normal hover:bg-hover",
				className,
			)}
		>
			{target.kind === "agent" ? (
				<>
					<AgentAvatar
						color={target.color}
						face={target.face}
						shape={target.shape}
						size={14}
						className="shrink-0 self-center"
					/>
					<span className="sr-only">@</span>
					{target.name}
				</>
			) : (
				`@${target.handle}`
			)}
			{after}
		</span>
	);
}

/** A mention in a sent message: its chip, a button that opens its card. */
function SentMention({ target }: { target: MentionTarget }) {
	const [open, setOpen] = useState(false);
	return (
		<MentionCard
			target={target}
			open={open}
			onOpenChange={setOpen}
			opensFrom={{ trigger: <MentionChip target={target} /> }}
		/>
	);
}

/** The element `remarkMentions` emits; `MarkdownMention` draws it. */
export const MENTION_TAG = "mention";

/**
 * Everyone a mention in the markdown below could name. It arrives through
 * context rather than the renderer's props because Streamdown redraws only when
 * its text changes: someone who becomes mentionable after a reply is drawn is
 * still marked in it. `@here` and `@channel` are among them only in a
 * person's message, the one kind that notifies anyone; see `groupMentionsBy`.
 */
export const MentionableContext = createContext<readonly MentionTarget[]>([]);

/**
 * Wraps each mention in a `<mention>` carrying its handle, for `MarkdownMention`
 * to draw. Not in a link, whose address can hold an `@`, as in
 * `medium.com/@ana`: a chip there would be a button inside the link.
 */
export const remarkMentions: Plugin<[], Root> = () => (tree) => {
	visit(tree, (node, index, parent) => {
		if (node.type === "link" || node.type === "linkReference") return SKIP;
		if (node.type !== "text") return;
		const parts = splitAroundMentions(node.value);
		if (!parent || index === undefined || parts.length === 1) return;
		const replacements = parts.map(
			(part, partIndex): PhrasingContent =>
				partIndex % 2 === 0
					? { type: "text", value: part }
					: {
							type: "text",
							value: `@${part}`,
							data: { hName: MENTION_TAG, hProperties: { handle: part } },
						},
		);
		parent.children.splice(index, 1, ...replacements);
		return index + replacements.length;
	});
};

/**
 * A `<mention>` from `remarkMentions`: a chip if it names someone in
 * `MentionableContext`, else its text. Its props come from the markdown tree
 * untyped, so the handle is checked rather than assumed.
 */
export function MarkdownMention({
	handle,
	children,
}: ExtraProps & { handle?: unknown; children?: unknown }) {
	const mentionable = useContext(MentionableContext);
	const target = typeof handle === "string" ? targetWithHandle(mentionable, handle) : undefined;
	return target ? <SentMention target={target} /> : (children as ReactNode);
}
