import type { ThreadParticipant } from "@sugabots/contracts";
import { cn } from "cn";
import type { PhrasingContent, Root } from "mdast";
import type { ReactNode } from "react";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

/*
 * `@handle` in a message, drawn in the colour of whoever it names. Two
 * renderers share one pattern: plain text is split around its matches, and
 * markdown has its text nodes split the same way by a remark plugin, so that a
 * mention inside a list item or a bold run is still a mention while one inside
 * a code span is left alone.
 */

/**
 * A handle at the start of a word, not the tail of an email address, and not
 * a prefix of a longer handle. Undefined where there is no one to name.
 */
function mentionPattern(mentionable: ThreadParticipant[]): RegExp | undefined {
	if (mentionable.length === 0) return undefined;
	const handles = mentionable
		.map((participant) => participant.handle)
		.sort((left, right) => right.length - left.length)
		.map(escapeRegularExpression);
	return new RegExp(`(?<![\\w.@])@(${handles.join("|")})(?![\\w-])`, "g");
}

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function Mention({ participant }: { participant: ThreadParticipant }) {
	return (
		<span
			className={cn(
				"box-decoration-clone rounded-md px-1 py-0.5 font-semibold",
				participant.kind === "agent"
					? "agent-tint bg-agent-wash text-agent-name"
					: "bg-primary-tint text-primary-tint-foreground",
			)}
			style={
				participant.kind === "agent" ? { ["--agent-hue" as string]: participant.hue } : undefined
			}
		>
			@{participant.handle}
		</span>
	);
}

/** Plain text with its mentions marked, for a bubble that is not markdown. */
export function textWithMentions(content: string, mentionable: ThreadParticipant[]): ReactNode {
	const pattern = mentionPattern(mentionable);
	if (!pattern) return content;
	const rendered: ReactNode[] = [];
	let previousEnd = 0;
	for (const match of content.matchAll(pattern)) {
		const participant = mentionable.find((candidate) => candidate.handle === match[1]);
		if (!participant) continue;
		rendered.push(content.slice(previousEnd, match.index));
		rendered.push(<Mention key={match.index} participant={participant} />);
		previousEnd = match.index + match[0].length;
	}
	if (rendered.length === 0) return content;
	return [...rendered, content.slice(previousEnd)];
}

/** The element the remark plugin emits; the renderer maps it back to `Mention`. */
export const MENTION_TAG = "mention";

/**
 * Splits markdown text nodes around mentions, wrapping each in a `<mention>`
 * element that carries the handle. Code spans are their own node type, so a
 * handle quoted in one is never matched.
 */
export const remarkMentions: Plugin<[ThreadParticipant[]], Root> = (mentionable) => {
	const pattern = mentionPattern(mentionable);
	return (tree) => {
		if (!pattern) return;
		visit(tree, "text", (node, index, parent) => {
			if (!parent || index === undefined) return;
			const replacements: PhrasingContent[] = [];
			let previousEnd = 0;
			for (const match of node.value.matchAll(pattern)) {
				if (match.index > previousEnd) {
					replacements.push({ type: "text", value: node.value.slice(previousEnd, match.index) });
				}
				replacements.push({
					type: "text",
					value: match[0],
					data: { hName: MENTION_TAG, hProperties: { handle: match[1] } },
				});
				previousEnd = match.index + match[0].length;
			}
			if (replacements.length === 0) return;
			if (previousEnd < node.value.length) {
				replacements.push({ type: "text", value: node.value.slice(previousEnd) });
			}
			parent.children.splice(index, 1, ...replacements);
			return index + replacements.length;
		});
	};
};
