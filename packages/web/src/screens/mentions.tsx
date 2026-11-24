import { botColorVariables } from "@sugabots/avatars";
import {
	type BotParticipant,
	type ChatDetails,
	type ChatKind,
	GROUP_MENTION_HANDLES,
	type GroupMentionHandle,
	type MemberParticipant,
	type MessageAuthor,
	mentionedHandles,
	notifiesMembers,
	type Participant,
	splitAroundMentions,
} from "@sugabots/contracts";
import { cn } from "cn";
import type { PhrasingContent, Root } from "mdast";
import { type ComponentProps, createContext, type ReactNode, useContext, useState } from "react";
import type { ExtraProps } from "streamdown";
import type { Plugin } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { BotAvatar } from "@/shell/Bot.tsx";
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
 * Everyone a mention in the chat can name: those in it, then the project's bots
 * and the members who reach the project who are not.
 */
export function mentionableIn(
	details: Pick<ChatDetails, "participants" | "projectBots" | "membersReachingProject">,
): Participant[] {
	const joined = new Set(details.participants.map(({ id }) => id));
	return [
		...details.participants,
		...details.projectBots.filter(({ id }) => !joined.has(id)),
		...details.membersReachingProject.filter(({ id }) => !joined.has(id)),
	];
}

/** The bots among `projectBots` that `draft` names, each once, in the order it first names them. */
export function botsNamed(draft: string, projectBots: readonly BotParticipant[]): BotParticipant[] {
	return mentionedHandles(draft).flatMap((handle) =>
		projectBots.filter((bot) => bot.handle === handle),
	);
}

/** `@here` or `@channel`, which a member writes in a chat to notify the members who reach its project. */
export interface GroupMention {
	kind: "group";
	handle: GroupMentionHandle;
	/**
	 * The members it would notify: those who reach the project but its writer, never a bot.
	 * Each one's own notification settings can still hold theirs back.
	 */
	notifies: readonly MemberParticipant[];
}

/** Whom a mention can name: a member or a bot, or with `@here` or `@channel`, everyone. */
export type MentionTarget = Participant | GroupMention;

/** Who writes a message, as far as `@here` and `@channel` care: a member, by id, or not a member. */
type Writer = { kind: "member"; id: string } | { kind: Exclude<MessageAuthor["kind"], "member"> };

/**
 * `@here` and `@channel` as `writer` can use them in a chat of kind
 * `chatKind`, each notifying `membersReachingProject` but the writer.
 * None where they would notify nobody, so they stay text: written by a bot or
 * an automation, in a chat that notifies nobody, or in a project
 * nobody else reaches.
 */
export function groupMentionsBy(
	writer: Writer,
	membersReachingProject: readonly MemberParticipant[],
	chatKind: ChatKind,
): GroupMention[] {
	if (writer.kind !== "member" || !notifiesMembers(chatKind)) return [];
	const notifies = membersReachingProject.filter((member) => member.id !== writer.id);
	if (notifies.length === 0) return [];
	return GROUP_MENTION_HANDLES.map((handle) => ({ kind: "group", handle, notifies }));
}

/**
 * Whom `signedIn`'s composer offers to mention in a chat of kind
 * `chatKind`: everyone `mentionableIn` gives but the current user, then
 * `@here` and `@channel` where they would notify anyone.
 */
export function composerMentionable(
	details: Pick<ChatDetails, "participants" | "projectBots" | "membersReachingProject">,
	signedIn: { id: string },
	chatKind: ChatKind,
): MentionTarget[] {
	return [
		...mentionableIn(details).filter((candidate) => candidate.id !== signedIn.id),
		...groupMentionsBy(
			{ kind: "member", id: signedIn.id },
			details.membersReachingProject,
			chatKind,
		),
	];
}

/**
 * Whom the handle `handle`, as a mention writes it, names among `mentionable`.
 * A member whose handle is that of `@here` or `@channel` is mentioned with everyone else.
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
 * and name, a member or everyone by the handle. Sent messages and the composer
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
	// A bot's in its own colour, a member's on a light wash that sits on any surface.
	const bot = target.kind === "bot" ? target : undefined;
	return (
		<span
			{...rest}
			data-mention-chip
			style={bot ? { ...botColorVariables(bot.color), ...rest.style } : rest.style}
			className={cn(
				"focus-ring mx-px inline-flex cursor-pointer items-baseline gap-1 rounded-md px-1.5 font-medium leading-normal transition hover:brightness-125",
				bot ? "bg-bot-tint text-bot-text" : "bg-foreground/10 text-foreground",
				className,
			)}
		>
			{target.kind === "bot" ? (
				<>
					<BotAvatar
						color={target.color}
						eyes={target.eyes}
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
 * member's message, the one kind that notifies anyone; see `groupMentionsBy`.
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
