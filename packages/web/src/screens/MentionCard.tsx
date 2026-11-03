import { Popover } from "@base-ui/react/popover";
import {
	type AgentParticipant,
	type PersonParticipant,
	workspaceRoleLabel,
} from "@sugabots/contracts";
import type { ReactElement } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useWorkspace, useWorkspaceMembers } from "@/lib/workspace.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import type { GroupMention, MentionTarget } from "./mentions.tsx";

/**
 * A card saying whom a mention names: a person's face, name, role and handle;
 * a bot's, with what it does; or for `@here` and `@channel`, the people it
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
			<Popover.Portal>
				<Popover.Positioner
					anchor={chip?.chip}
					side="bottom"
					align="start"
					sideOffset={6}
					collisionPadding={16}
					className="isolate z-50 outline-none"
				>
					<Popover.Popup
						finalFocus={chip ? false : undefined}
						onKeyDown={(event) => {
							if (event.key !== "Escape") return;
							// Handled, so the panel around the chat leaves it to the card.
							event.preventDefault();
							onOpenChange(false);
							chip?.returnFocus();
						}}
						className="w-72 origin-(--transform-origin) rounded-lg border border-border-strong bg-panel p-3 text-foreground shadow-popover outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95"
					>
						{target.kind === "group" ? (
							<GroupCard group={target} />
						) : target.kind === "agent" ? (
							<BotCard bot={target} />
						) : (
							<PersonCard person={target} />
						)}
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
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

/** A word beside a card's title saying what it names: a bot, or a person's role. */
function TitleTag({ children }: { children: string }) {
	return (
		<span className="shrink-0 rounded bg-chip px-1.25 py-px font-semibold text-2xs text-muted-foreground leading-snug">
			{children}
		</span>
	);
}

function PersonCard({ person }: { person: PersonParticipant }) {
	return (
		<CardHeading
			face={<PersonAvatar person={person} size={40} />}
			title={
				<>
					<span className="truncate">{person.name}</span>
					<PersonRole personId={person.id} />
				</>
			}
			subtitle={`@${person.handle}`}
		/>
	);
}

/** The person's role in the workspace, once its members are loaded. */
function PersonRole({ personId }: { personId: string }) {
	const { workspace } = useWorkspace();
	const { data: members } = useWorkspaceMembers(workspace?.id);
	const role = members?.find((member) => member.user.id === personId)?.role;
	if (!role) return null;
	return <TitleTag>{workspaceRoleLabel(role)}</TitleTag>;
}

function BotCard({ bot }: { bot: AgentParticipant }) {
	return (
		<>
			<CardHeading
				face={<AgentAvatar color={bot.color} face={bot.face} shape={bot.shape} size={40} />}
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
	const { agents } = useAgents();
	const description = agents?.find((bot) => bot.id === botId)?.description;
	if (!description) return null;
	return (
		<p className="m-0 mt-2.5 wrap-break-word text-soft-foreground text-xs leading-normal">
			{description}
		</p>
	);
}

/**
 * How many rows a group mention's card has for its people: each person, up to
 * this many, else one fewer and a line counting the rest.
 */
const MAX_PEOPLE_ROWS = 6;

function GroupCard({ group }: { group: GroupMention }) {
	const people = group.notifies;
	const listed = people.length > MAX_PEOPLE_ROWS ? people.slice(0, MAX_PEOPLE_ROWS - 1) : people;
	const others = people.length - listed.length;
	return (
		<>
			<Popover.Title className="m-0 font-semibold text-sm leading-snug">
				@{group.handle}
			</Popover.Title>
			<ul aria-label="Notifies" className="m-0 mt-2.5 flex list-none flex-col gap-1.5 p-0">
				{listed.map((person) => (
					<li key={person.id} className="flex min-w-0 items-center gap-2 text-sm">
						<span aria-hidden className="flex">
							<PersonAvatar person={person} size={20} />
						</span>
						<span className="truncate">{person.name}</span>
					</li>
				))}
			</ul>
			{others > 0 && <p className="m-0 mt-1.5 text-muted-foreground text-xs">and {others} more</p>}
		</>
	);
}
