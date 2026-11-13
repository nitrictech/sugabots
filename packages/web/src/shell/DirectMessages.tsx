import type { DirectMessageListItem, PersonParticipant } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRight, MessageCircle, Plus, User } from "lucide-react";
import {
	type DirectPeople,
	directPeopleNames,
	directPeopleRowName,
	isOneToOne,
	useDirectMessages,
} from "@/lib/chats.ts";
import { useFolded } from "@/lib/folded.ts";
import { directMessageLink, newDirectMessageLink } from "@/lib/links.ts";
import { countOf } from "@/lib/name-list.ts";
import { END_SLOT, NESTED_INDENT, sidebarRowClassName } from "@/shell/ConversationList.tsx";
import { ListTime } from "@/shell/Page.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { buttonStyles } from "@/ui/button.tsx";
import { CountBadge } from "@/ui/count-badge.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";

/** How large each of a group's two overlapping faces is, as a share of the whole avatar. */
const GROUP_FACE_SCALE = 0.72;
/** From this size up, as on a phone's list, the ring between a group's faces is thicker. */
const LARGE_AVATAR_PX = 32;
const LARGE_RING_PX = 2;
const SMALL_RING_PX = 1.5;

/** What the sidebar folds Direct messages away by. */
const FOLD_KEY = "direct-messages";

/** How a list of direct messages is doing at loading. */
export type DirectMessagesStatus = "loading" | "ready" | "failed";

/** The sidebar's Direct messages, with New message, which opens the page that starts one. */
export function DirectMessages({
	selectedConversationId,
	newMessageOpen = false,
}: {
	selectedConversationId?: string;
	newMessageOpen?: boolean;
}) {
	const list = useDirectMessages();
	return (
		<DirectMessagesSection
			items={list.data?.items ?? []}
			status={list.isError ? "failed" : list.isSuccess ? "ready" : "loading"}
			selectedConversationId={selectedConversationId}
			newMessageOpen={newMessageOpen}
		/>
	);
}

/**
 * Direct messages in the sidebar, under the pods, beneath a heading that
 * folds them away, most recent first: each with the person's face, or for a
 * group how many others are in it, bold and counted while something in it is
 * unread.
 * New message is the last row. Folded, the heading says what is new.
 */
export function DirectMessagesSection({
	items,
	status,
	selectedConversationId,
	newMessageOpen = false,
}: {
	items: readonly DirectMessageListItem[];
	status: DirectMessagesStatus;
	/** The direct message open on the page, if one is. */
	selectedConversationId?: string;
	/** Whether New message is the page open. */
	newMessageOpen?: boolean;
}) {
	const [folded, toggleFolded] = useFolded();
	const open = !folded.has(FOLD_KEY);
	return (
		<section aria-label="Direct messages" className="flex flex-col gap-px">
			<DirectMessagesHeading
				open={open}
				onToggle={() => toggleFolded(FOLD_KEY)}
				unreadMessages={items.reduce((sum, item) => sum + item.unreadMessages, 0)}
			/>
			{open && (
				<div className={cn("flex flex-col gap-px", NESTED_INDENT)}>
					{status === "failed" && (
						<p className="m-0 px-2 py-1 text-xs text-muted-foreground">
							Could not load your direct messages.
						</p>
					)}
					<ul className="m-0 flex list-none flex-col gap-px p-0">
						{items.map((item) => (
							<li key={item.conversation.id}>
								<DirectMessageRow
									item={item}
									selected={item.conversation.id === selectedConversationId}
								/>
							</li>
						))}
					</ul>
					<Link
						{...newDirectMessageLink()}
						aria-current={newMessageOpen ? "page" : undefined}
						className={sidebarRowClassName(newMessageOpen)}
					>
						<span
							aria-hidden
							className="grid size-4.5 shrink-0 place-items-center rounded-full border border-border-strong"
						>
							<Plus size={10} strokeWidth={2.4} className="block" />
						</span>
						New message
					</Link>
				</div>
			)}
		</section>
	);
}

/**
 * Direct messages' heading, a row like a pod's, which folds them away or
 * opens them. Folded over something unread, it is bold, and says how much to
 * a screen reader.
 */
function DirectMessagesHeading({
	open,
	onToggle,
	unreadMessages,
}: {
	open: boolean;
	onToggle: () => void;
	unreadMessages: number;
}) {
	const lit = !open && unreadMessages > 0;
	return (
		<h2 className="group/section m-0 flex h-8 items-center rounded-sm pr-1.5 font-normal transition-colors hover:bg-row-hover">
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className="focus-ring flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-sm pl-2 text-left"
			>
				<span className="grid size-5 shrink-0 place-items-center text-muted-foreground *:col-start-1 *:row-start-1">
					<MessageCircle
						aria-hidden
						size={16}
						strokeWidth={2}
						className="group-hover/section:invisible group-has-focus-visible/section:invisible"
					/>
					<ChevronRight
						aria-hidden
						size={14}
						strokeWidth={2.25}
						className={cn(
							"invisible transition-transform group-hover/section:visible group-has-focus-visible/section:visible",
							open && "rotate-90",
						)}
					/>
				</span>
				<span
					className={cn(
						"min-w-0 truncate text-sm",
						lit
							? "font-semibold text-foreground"
							: "font-medium text-muted-foreground group-hover/section:text-foreground",
					)}
				>
					Direct messages
				</span>
				{lit && (
					<span className="sr-only">
						{countOf(unreadMessages, "unread message", "unread messages")}
					</span>
				)}
			</button>
		</h2>
	);
}

/**
 * A direct message in the sidebar: whose it is, and at its end what is new in
 * it. One with a single person shows their face and name; a group, how many
 * others are in it and their first names, which is all a sidebar row has
 * room for.
 */
function DirectMessageRow({ item, selected }: { item: DirectMessageListItem; selected: boolean }) {
	const lit = item.unreadMessages > 0;
	const group = !isOneToOne(item);
	return (
		<Link
			{...directMessageLink(item.conversation.id)}
			aria-current={selected ? "page" : undefined}
			className={sidebarRowClassName(selected)}
		>
			{group ? (
				<span
					aria-hidden
					className="grid size-4.5 shrink-0 place-items-center rounded-xs bg-chip font-semibold text-2xs text-soft-foreground tabular-nums"
				>
					{item.people.length + item.formerMembers}
				</span>
			) : (
				<DirectPeopleAvatar {...item} size={18} />
			)}
			<span className={cn("min-w-0 flex-1 truncate-fade", lit && "font-semibold text-foreground")}>
				{group ? groupRowName(item) : directPeopleRowName(item)}
			</span>
			<span className={cn(END_SLOT, "w-auto min-w-5.5")}>
				<DirectMessageNews item={item} />
			</span>
		</Link>
	);
}

/** A group's others by first name, then those who have left as how many: "Juno, Ravi, 1 former member". */
function groupRowName({ people, formerMembers }: DirectMessageListItem): string {
	return directPeopleNames({
		people: people.map((person) => ({ ...person, name: firstNameOf(person.name) })),
		formerMembers,
	}).join(", ");
}

/** The first word of somebody's name: "Juno" of "Juno Clarke". */
function firstNameOf(name: string): string {
	return name.trim().split(/\s+/)[0] ?? name;
}

/** What is new in a direct message: how many of its messages the viewer has not read. */
function DirectMessageNews({ item }: { item: DirectMessageListItem }) {
	if (item.unreadMessages === 0) return null;
	return (
		<CountBadge
			count={item.unreadMessages}
			size="md"
			label={countOf(item.unreadMessages, "unread message", "unread messages")}
		/>
	);
}

/**
 * The direct messages on a phone's page of them, most recent first: each with
 * whose it is, its latest message and when, and what is new in it.
 */
export function DirectMessageCards({
	items,
	status,
}: {
	items: readonly DirectMessageListItem[];
	status: DirectMessagesStatus;
}) {
	if (status === "failed") {
		return (
			<p className="m-0 px-3 py-3 text-base text-muted-foreground">
				Could not load your direct messages.
			</p>
		);
	}
	if (status === "ready" && items.length === 0) {
		return (
			<p className="m-0 px-3 py-10 text-center text-base text-muted-foreground">
				No direct messages yet. Tap + to message somebody.
			</p>
		);
	}
	return (
		<ul className="m-0 flex list-none flex-col gap-0.5 p-0">
			{items.map((item) => {
				const lit = item.unreadMessages > 0;
				return (
					<li key={item.conversation.id}>
						<Link
							{...directMessageLink(item.conversation.id)}
							className="focus-ring flex items-center gap-3 rounded-xl px-3 py-2.5 active:bg-row-selected"
						>
							<DirectPeopleAvatar {...item} size={40} ring="var(--list)" />
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="flex min-w-0 items-baseline gap-2">
									<span
										className={cn(
											"min-w-0 flex-1 truncate text-base text-foreground",
											lit && "font-semibold",
										)}
									>
										{directPeopleRowName(item)}
									</span>
									{item.lastMessage && <ListTime at={item.lastMessage.at} />}
								</span>
								<span className="flex min-w-0 items-center gap-2">
									<span
										className={cn(
											"min-w-0 flex-1 truncate text-sm",
											lit ? "text-soft-foreground" : "text-muted-foreground",
										)}
									>
										{item.lastMessage?.preview ?? "No messages yet"}
									</span>
									<DirectMessageNews item={item} />
								</span>
							</span>
						</Link>
					</li>
				);
			})}
		</ul>
	);
}

/** Beside the sidebar while no direct message is open: what they are, and a way to start one. */
export function DirectMessagesOverview() {
	return (
		<div className="flex h-full pb-20">
			<EmptyState icon={<MessageCircle strokeWidth={1.75} />} title="Direct messages">
				<p className="m-0">
					Write to one person or a few, where nobody else sees. Choose a conversation on the left,
					or start a new one.
				</p>
				<Link {...newDirectMessageLink()} className={cn(buttonStyles(), "mt-4")}>
					New message
				</Link>
			</EmptyState>
		</div>
	);
}

/**
 * The others in a direct message as one face: the person, or a plain figure
 * once they have left the workspace; for a group, the first two of them
 * overlapping, the second ringed in `ring`, the colour of the surface under it.
 */
export function DirectPeopleAvatar({
	people,
	formerMembers,
	size,
	ring = "var(--background)",
}: DirectPeople & {
	size: number;
	ring?: string;
}) {
	const [first = null, second = null] = people;
	if (isOneToOne({ people, formerMembers })) return <PersonFace person={first} size={size} />;
	const face = Math.round(size * GROUP_FACE_SCALE);
	return (
		<span aria-hidden className="relative shrink-0" style={{ width: size, height: size }}>
			<span className="absolute top-0 left-0 flex">
				<PersonFace person={first} size={face} />
			</span>
			<span
				className="absolute right-0 bottom-0 flex rounded-full"
				style={{
					boxShadow: `0 0 0 ${size >= LARGE_AVATAR_PX ? LARGE_RING_PX : SMALL_RING_PX}px ${ring}`,
				}}
			>
				<PersonFace person={second} size={face} />
			</span>
		</span>
	);
}

/** A person's face, or a plain figure once they have left the workspace. */
function PersonFace({ person, size }: { person: PersonParticipant | null; size: number }) {
	if (!person) return <FormerMemberFace size={size} />;
	// Hidden, as a bot's face is: its initials would be read out ahead of the name beside it.
	return (
		<span aria-hidden className="flex shrink-0">
			<PersonAvatar person={person} size={size} />
		</span>
	);
}

/** How large the figure in a former member's face is, as a share of the face. */
const FORMER_MEMBER_FIGURE_SCALE = 0.6;

/** In place of the face of somebody who has left the workspace: a plain figure, as nobody is named. */
export function FormerMemberFace({ size }: { size: number }) {
	return (
		<span
			aria-hidden
			className="grid shrink-0 place-items-center rounded-full bg-person-avatar text-person-avatar-foreground"
			style={{ width: size, height: size }}
		>
			<User size={Math.round(size * FORMER_MEMBER_FIGURE_SCALE)} strokeWidth={2} />
		</span>
	);
}
