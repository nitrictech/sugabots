import { botColorVariables } from "@sugabots/avatars";
import { splitAroundMentions, type ThreadParticipant } from "@sugabots/contracts";
import { cn } from "cn";
import type { PhrasingContent, Root } from "mdast";
import { createContext, type ReactNode, useContext } from "react";
import type { ExtraProps } from "streamdown";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

/*
 * `@handle` in a message, drawn in the colours of whoever it names. Plain text
 * and markdown text nodes are both split with the parser the API routes by, so
 * a mention inside a list item or a bold run is still a mention while one
 * inside a code span, its own node type, is left alone.
 */

function participantWithHandle(
	mentionable: ThreadParticipant[],
	handle: string,
): ThreadParticipant | undefined {
	const lowered = handle.toLowerCase();
	return mentionable.find((candidate) => candidate.handle === lowered);
}

/**
 * An agent is named on its own tint in its brighter mono colour, the way a bot
 * draws an inline ID; a person on a neutral chip. Both are edged, so a chip
 * still stands out on a bubble of the same tint, as a bot naming itself does.
 */
function Mention({ participant }: { participant: ThreadParticipant }) {
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
export function textWithMentions(content: string, mentionable: ThreadParticipant[]): ReactNode[] {
	return splitAroundMentions(content).map((part, index) => {
		if (index % 2 === 0) return part;
		const participant = participantWithHandle(mentionable, part);
		return participant ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: a part's position in the text is its identity.
			<Mention key={index} participant={participant} />
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
 * still marked in it.
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
	const participant =
		typeof handle === "string" ? participantWithHandle(mentionable, handle) : undefined;
	return participant ? <Mention participant={participant} /> : (children as ReactNode);
}
