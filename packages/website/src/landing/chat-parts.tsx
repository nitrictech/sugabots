import { BotFace, type BotLook } from "@sugabots/avatars";
import { cn } from "cn";
import type { ReactNode } from "react";

export interface Person {
	name: string;
	initials: string;
	/** A licensed photo; without one, the avatar shows the initials. */
	photo?: string;
}

export interface Bot {
	name: string;
	look: BotLook;
}

export type Author = { kind: "person"; person: Person } | { kind: "bot"; bot: Bot };

/** The people and bots in the card demos. Their photos are from Unsplash; see the README. */
export const people = {
	gary: { name: "Gary Lum", initials: "GL", photo: "/people/gary-lum.jpg" },
	lorraine: { name: "Lorraine Delgado", initials: "LD", photo: "/people/lorraine-delgado.jpg" },
} as const satisfies Record<string, Person>;

export const crew = {
	growthDesk: { name: "Growth Desk", look: { color: "green", face: "pill", shape: "leaf" } },
	pricingAnalyst: {
		name: "Pricing Analyst",
		look: { color: "sky", face: "pill", shape: "hexagon" },
	},
	copywriter: { name: "Copywriter", look: { color: "orange", face: "pill", shape: "blob" } },
	researcher: { name: "Researcher", look: { color: "sky", face: "pill", shape: "drop" } },
	inboxSorter: { name: "Inbox Sorter", look: { color: "green", face: "pill", shape: "squircle" } },
	journal: { name: "Journal", look: { color: "purple", face: "pill", shape: "pebble" } },
	ticketDesk: { name: "Ticket Desk", look: { color: "purple", face: "pill", shape: "circle" } },
} as const satisfies Record<string, Bot>;

export function PersonAvatar({ person, className }: { person: Person; className?: string }) {
	return (
		<span
			className={cn(
				"grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-landing-button text-[11px] font-semibold text-landing-secondary",
				className,
			)}
		>
			{person.photo ? (
				<img src={person.photo} alt="" className="size-full object-cover" />
			) : (
				<span aria-hidden>{person.initials}</span>
			)}
		</span>
	);
}

export function AuthorAvatar({ author, className }: { author: Author; className?: string }) {
	if (author.kind === "person")
		return <PersonAvatar person={author.person} className={className} />;
	return <BotFace {...author.bot.look} className={cn("size-7", className)} />;
}

export function authorName(author: Author) {
	return author.kind === "person" ? author.person.name : author.bot.name;
}

/** The author's name, the app's "Bot" chip for a bot, and when they said it, as a message row heads its text. */
function MessageByline({ name, time, isBot }: { name: string; time: string; isBot: boolean }) {
	return (
		<span className="flex items-center gap-2">
			<span className="text-sm font-semibold text-landing-text">{name}</span>
			{isBot && (
				<span className="rounded-[4px] bg-landing-chip px-[5px] py-px text-[10.5px]/[1.4] font-semibold text-landing-muted">
					Bot
				</span>
			)}
			<span className="text-xs text-landing-faint">{time}</span>
		</span>
	);
}

interface MessageRowProps {
	author: Author;
	time: string;
	text: string;
	/** What hangs under the text, such as a reaction. */
	children?: ReactNode;
	className?: string;
}

/** One message as the app shows it: the author's avatar, then their name, the time and what they said. */
export function MessageRow({ author, time, text, children, className }: MessageRowProps) {
	return (
		<div className={cn("flex gap-3", className)}>
			<AuthorAvatar author={author} />
			<div className="flex min-w-0 flex-col gap-0.5">
				<MessageByline name={authorName(author)} time={time} isBot={author.kind === "bot"} />
				<p className="text-sm/[1.5] text-pretty text-landing-message">{text}</p>
				{children}
			</div>
		</div>
	);
}

/** How a message arrives in a demo: a short fade and rise. */
export const arrive =
	"animate-in fade-in slide-in-from-bottom-1.5 duration-260 ease-landing motion-reduce:animate-none";
