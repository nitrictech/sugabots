import {
	type AgentParticipant,
	mentionedHandles,
	splitAroundMentions,
	type ThreadDetails,
	type ThreadParticipant,
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

/** Whom the handle `handle`, as a mention writes it, names among `mentionable`. */
export function participantWithHandle(
	mentionable: readonly ThreadParticipant[],
	handle: string,
): ThreadParticipant | undefined {
	const lowered = handle.toLowerCase();
	return mentionable.find((candidate) => candidate.handle === lowered);
}

/**
 * A mention as a chip that stands off the words around it: a bot by its face
 * and name, a person by their handle. Sent messages and the composer both
 * draw it, so a mention looks the same before and after it is sent.
 */
export function MentionChip({
	participant,
	className,
	...rest
}: { participant: ThreadParticipant } & ComponentProps<"span">) {
	return (
		<span
			{...rest}
			className={cn(
				"mx-px inline-flex items-center gap-1 rounded-[5px] bg-chip px-1 align-[-0.15em] font-semibold text-foreground leading-[1.5]",
				className,
			)}
		>
			{participant.kind === "agent" ? (
				<>
					<AgentAvatar
						color={participant.color}
						face={participant.face}
						shape={participant.shape}
						size={14}
						className="shrink-0"
					/>
					<span className="sr-only">@</span>
					{participant.name}
				</>
			) : (
				`@${participant.handle}`
			)}
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
			<MentionChip key={index} participant={participant} />
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
	return participant ? <MentionChip participant={participant} /> : (children as ReactNode);
}
