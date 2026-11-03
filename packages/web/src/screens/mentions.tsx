import {
	type AgentParticipant,
	GROUP_MENTION_HANDLES,
	type GroupMentionHandle,
	mentionedHandles,
	NOTIFYING_THREAD_TYPES,
	splitAroundMentions,
	type ThreadDetails,
	type ThreadParticipant,
	type ThreadType,
} from "@sugabots/contracts";
import { cn } from "cn";
import type { PhrasingContent, Root } from "mdast";
import { type ComponentProps, createContext, type ReactNode, useContext } from "react";
import type { ExtraProps } from "streamdown";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { AgentAvatar } from "@/shell/Agent.tsx";

/*
 * `@handle` in a message, drawn as a chip for whoever it names. Plain text
 * and markdown text nodes are both split with the parser the API routes by, so
 * a mention inside a list item or a bold run is still a mention while one
 * inside a code span, its own node type, is left alone.
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

/**
 * The bot named first in `draft` among `crew`, which sending from a pod's
 * chat starts a thread with; any named after it are only mentioned.
 */
export function firstBotNamed(
	draft: string,
	crew: readonly ThreadParticipant[],
): AgentParticipant | undefined {
	const bots = crew.filter((member): member is AgentParticipant => member.kind === "agent");
	return mentionedHandles(draft)
		.flatMap((handle) => bots.filter((bot) => bot.handle === handle))
		.at(0);
}

/** `@here` or `@channel`, which a person writes to notify everyone who can see the conversation. */
export interface GroupMention {
	kind: "group";
	handle: GroupMentionHandle;
}

/** Whom a mention can name: a person or a bot, or with `@here` or `@channel`, everyone. */
export type MentionTarget = ThreadParticipant | GroupMention;

export const GROUP_MENTIONS: readonly GroupMention[] = GROUP_MENTION_HANDLES.map((handle) => ({
	kind: "group",
	handle,
}));

/**
 * `mentionable`, and after it `@here` and `@channel` where a person writing in
 * a thread of `threadType` would notify somebody with them.
 */
export function withGroupMentions(
	mentionable: readonly ThreadParticipant[],
	threadType: ThreadType,
): MentionTarget[] {
	const notifiesSomebody =
		NOTIFYING_THREAD_TYPES.has(threadType) &&
		mentionable.some((candidate) => candidate.kind === "person");
	return notifiesSomebody ? [...mentionable, ...GROUP_MENTIONS] : [...mentionable];
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
 * both draw it, so a mention looks the same before and after it is sent.
 */
export function MentionChip({
	target,
	className,
	...rest
}: { target: MentionTarget } & ComponentProps<"span">) {
	return (
		<span
			{...rest}
			className={cn(
				"mx-px inline-flex items-baseline gap-1 rounded-[5px] bg-chip px-1 font-semibold text-foreground leading-[1.5]",
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
		</span>
	);
}

/** Plain text with its mentions marked, for a bubble that is not markdown. */
export function textWithMentions(
	content: string,
	mentionable: readonly MentionTarget[],
): ReactNode[] {
	return splitAroundMentions(content).map((part, index) => {
		if (index % 2 === 0) return part;
		const target = targetWithHandle(mentionable, part);
		return target ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: a part's position in the text is its identity.
			<MentionChip key={index} target={target} />
		) : (
			`@${part}`
		);
	});
}

/** The element `remarkMentions` emits; `MarkdownMention` draws it. */
export const MENTION_TAG = "mention";

/**
 * Everyone a mention in the markdown below could name. It arrives through
 * context rather than the renderer's props because Streamdown redraws only when
 * its text changes: someone who becomes mentionable after a reply is drawn is
 * still marked in it. Never `@here` or `@channel`: markdown is what bots,
 * routines and artifacts write, and only a person's notifies anyone.
 */
export const MentionableContext = createContext<ThreadParticipant[]>([]);

/** Wraps each mention in a `<mention>` carrying its handle, for `MarkdownMention` to draw. */
export const remarkMentions: Plugin<[], Root> = () => (tree) => {
	visit(tree, "text", (node, index, parent) => {
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
	return target ? <MentionChip target={target} /> : (children as ReactNode);
}
