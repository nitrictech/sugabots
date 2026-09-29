import { botColorVariables } from "@sugabots/avatars";
import {
	type MentionInText,
	mentionsIn,
	type ThreadDetails,
	type ThreadParticipant,
} from "@sugabots/contracts";
import { cn } from "cn";
import type { PhrasingContent, Root } from "mdast";
import { createContext, type ReactNode, useContext } from "react";
import type { ExtraProps } from "streamdown";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

/*
 * `@handle` in a message, drawn in the colours of whoever it names. Two
 * renderers share one reading of the text, the one the API routes by: plain
 * text is split around its mentions, and markdown has its text nodes split the
 * same way by a remark plugin, so that a mention inside a list item or a bold
 * run is still a mention while one inside a code span is left alone.
 */

/**
 * Everyone a mention in this thread could name: the people and agents who have
 * spoken, plus the rest of the pod's crew.
 *
 * The crew matters because an agent named in a chat never joins it — the
 * chat's own bot collaborates with it instead — and the first time an agent is
 * named anywhere it has not joined yet. Reading names against the participants
 * alone leaves exactly those unrecognised.
 */
export function mentionableIn(details: ThreadDetails): ThreadParticipant[] {
	const joined = new Set(details.participants.map((participant) => participant.id));
	return [...details.participants, ...details.crew.filter((member) => !joined.has(member.id))];
}

/** A mention and the participant it names. A handle that names nobody is left as text. */
interface NamedMention extends MentionInText {
	participant: ThreadParticipant;
}

function namedMentionsIn(content: string, mentionable: ThreadParticipant[]): NamedMention[] {
	return mentionsIn(content).flatMap((mention) => {
		const participant = participantWithHandle(mentionable, mention.handle);
		return participant ? [{ ...mention, participant }] : [];
	});
}

function participantWithHandle(
	mentionable: ThreadParticipant[],
	handle: string,
): ThreadParticipant | undefined {
	return mentionable.find((candidate) => candidate.handle === handle);
}

/**
 * An agent is named on its own tint in its brighter mono colour, the way a bot
 * draws an inline ID; a person on a neutral chip. Both are edged, so a chip
 * still stands out on a bubble of the same tint, as a bot naming itself does.
 */
export function Mention({ participant }: { participant: ThreadParticipant }) {
	return (
		<span
			className={cn(
				"box-decoration-clone rounded-xs px-[0.3em] font-semibold",
				participant.kind === "agent"
					? "bg-bot-tint text-bot-mono shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--bot-mono)_25%,transparent)]"
					: "bg-chip text-foreground shadow-[inset_0_0_0_1px_var(--border-strong)]",
			)}
			style={participant.kind === "agent" ? botColorVariables(participant.color) : undefined}
		>
			@{participant.handle}
		</span>
	);
}

/** Plain text with its mentions marked, for a bubble that is not markdown. */
export function textWithMentions(content: string, mentionable: ThreadParticipant[]): ReactNode {
	const mentions = namedMentionsIn(content, mentionable);
	if (mentions.length === 0) return content;
	const rendered: ReactNode[] = [];
	let previousEnd = 0;
	for (const mention of mentions) {
		rendered.push(content.slice(previousEnd, mention.index));
		rendered.push(<Mention key={mention.index} participant={mention.participant} />);
		previousEnd = mention.index + mention.length;
	}
	return [...rendered, content.slice(previousEnd)];
}

/** The element the remark plugin emits; `MarkdownMention` draws it. */
export const MENTION_TAG = "mention";

/**
 * Everyone a mention in the markdown below could name. Markdown reaches the
 * list through context rather than through the renderer's props, because
 * Streamdown redraws only when its text or styling changes: someone who
 * becomes mentionable after a reply is drawn is still marked in it.
 */
export const MentionableContext = createContext<ThreadParticipant[]>([]);

/**
 * Splits markdown text nodes around mentions, wrapping each in a `<mention>`
 * element that carries the handle, whether or not it names anyone; that is
 * for `MarkdownMention` to say. Code spans are their own node type, so a
 * handle quoted in one is never matched.
 */
export const remarkMentions: Plugin<[], Root> = () => (tree) => {
	visit(tree, "text", (node, index, parent) => {
		if (!parent || index === undefined) return;
		const mentions = mentionsIn(node.value);
		if (mentions.length === 0) return;
		const replacements: PhrasingContent[] = [];
		let previousEnd = 0;
		for (const mention of mentions) {
			if (mention.index > previousEnd) {
				replacements.push({ type: "text", value: node.value.slice(previousEnd, mention.index) });
			}
			const end = mention.index + mention.length;
			replacements.push({
				type: "text",
				value: node.value.slice(mention.index, end),
				data: { hName: MENTION_TAG, hProperties: { handle: mention.handle } },
			});
			previousEnd = end;
		}
		if (previousEnd < node.value.length) {
			replacements.push({ type: "text", value: node.value.slice(previousEnd) });
		}
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
	const participant =
		typeof handle === "string" ? participantWithHandle(mentionable, handle) : undefined;
	return participant ? <Mention participant={participant} /> : (children as ReactNode);
}
