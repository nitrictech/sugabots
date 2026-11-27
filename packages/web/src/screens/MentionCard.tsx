import { Popover } from "@base-ui/react/popover";
import {
	type BotParticipant,
	type MemberParticipant,
	workspaceRoleLabel,
} from "@sugabots/contracts";
import type { ReactElement } from "react";
import { useBot } from "@/lib/bots.ts";
import { useMemberships, useWorkspace } from "@/lib/workspace.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { MemberAvatar } from "@/ui/avatar.tsx";
import { PopoverContent } from "@/ui/popover.tsx";
import { TitleTag } from "@/ui/title-tag.tsx";
import type { GroupMention, MentionTarget } from "./mentions.tsx";

/**
 * A card saying whom a mention names: a member's face, name, role and handle;
 * a bot's, with what it does; or for `@here` and `@channel`, the members it
 * would notify. A click or tap outside it closes it, and so does Escape, which
 * closes nothing else, so a panel the mention is in stays open.
 */
export function MentionCard({
	target,
	open,
	onOpenChange,
	opensFrom,
}: {
	target: MentionTarget;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * `trigger`: the chip, made a button that opens the card and takes the
	 * focus back when it closes. `chip`: one React does not draw, as in the
	 * composer, which the card shows against; Escape calls `returnFocus`, and a
	 * click or tap elsewhere leaves the focus where it landed.
	 */
	opensFrom: { trigger: ReactElement } | { chip: Element; returnFocus: () => void };
}) {
	const chip = "chip" in opensFrom ? opensFrom : undefined;
	return (
		<Popover.Root open={open} onOpenChange={onOpenChange}>
			{"trigger" in opensFrom && (
				<Popover.Trigger nativeButton={false} render={opensFrom.trigger} />
			)}
			<PopoverContent
				anchor={chip?.chip}
				finalFocus={chip ? false : undefined}
				onKeyDown={(event) => {
					if (event.key !== "Escape") return;
					// Handled, so the panel around the chat leaves it to the card.
					event.preventDefault();
					onOpenChange(false);
					chip?.returnFocus();
				}}
				className="w-72 p-3"
			>
				{target.kind === "group" ? (
					<GroupCard group={target} />
				) : target.kind === "bot" ? (
					<BotCard bot={target} />
				) : (
					<MemberCard member={target} />
				)}
			</PopoverContent>
		</Popover.Root>
	);
}

/** The face beside a card's title, and the title, with a line under it. */
function CardHeading({
	face,
	title,
	subtitle,
}: {
	face: ReactElement;
	title: ReactElement | string;
	subtitle: string;
}) {
	return (
		<div className="flex items-center gap-2.5">
			<span aria-hidden className="flex shrink-0">
				{face}
			</span>
			<div className="flex min-w-0 flex-col gap-px">
				<Popover.Title className="m-0 flex min-w-0 items-center gap-2 font-semibold text-sm leading-snug">
					{title}
				</Popover.Title>
				<span className="truncate text-muted-foreground text-xs">{subtitle}</span>
			</div>
		</div>
	);
}

function MemberCard({ member }: { member: MemberParticipant }) {
	return (
		<CardHeading
			face={<MemberAvatar member={member} size={40} />}
			title={
				<>
					<span className="truncate">{member.name}</span>
					<MemberRole memberId={member.id} />
				</>
			}
			subtitle={`@${member.handle}`}
		/>
	);
}

/** The member's role in the workspace, once its memberships are loaded. */
function MemberRole({ memberId }: { memberId: string }) {
	const { workspace } = useWorkspace();
	const { data: memberships } = useMemberships(workspace?.id);
	const role = memberships?.find((membership) => membership.member.id === memberId)?.role;
	if (!role) return null;
	return <TitleTag>{workspaceRoleLabel(role)}</TitleTag>;
}

function BotCard({ bot }: { bot: BotParticipant }) {
	return (
		<>
			<CardHeading
				face={<BotAvatar color={bot.color} eyes={bot.eyes} shape={bot.shape} size={40} />}
				title={
					<>
						<span className="truncate">{bot.name}</span>
						<TitleTag>Bot</TitleTag>
					</>
				}
				subtitle={`@${bot.handle}`}
			/>
			<BotDescription botId={bot.id} />
		</>
	);
}

/** What the bot does, in its own words from its settings, once the workspace's bots are loaded. */
function BotDescription({ botId }: { botId: string }) {
	const description = useBot(botId)?.description;
	if (!description) return null;
	return (
		<p className="m-0 mt-2.5 wrap-break-word text-soft-foreground text-xs leading-normal">
			{description}
		</p>
	);
}

/**
 * How many rows a group mention's card has for its members: each member, up to
 * this many, else one fewer and a line counting the rest.
 */
const MAX_MEMBERS_ROWS = 6;

function GroupCard({ group }: { group: GroupMention }) {
	const members = group.notifies;
	const listed =
		members.length > MAX_MEMBERS_ROWS ? members.slice(0, MAX_MEMBERS_ROWS - 1) : members;
	const others = members.length - listed.length;
	return (
		<>
			<Popover.Title className="m-0 font-semibold text-sm leading-snug">
				@{group.handle}
			</Popover.Title>
			<ul aria-label="Notifies" className="m-0 mt-2.5 flex list-none flex-col gap-1.5 p-0">
				{listed.map((member) => (
					<li key={member.id} className="flex min-w-0 items-center gap-2 text-sm">
						<span aria-hidden className="flex">
							<MemberAvatar member={member} size={20} />
						</span>
						<span className="truncate">{member.name}</span>
					</li>
				))}
			</ul>
			{others > 0 && <p className="m-0 mt-1.5 text-muted-foreground text-xs">and {others} more</p>}
		</>
	);
}
