import { StillBotFace } from "@sugabots/avatars";
import { cn } from "cn";
import type { ReactNode } from "react";
import type { ChatAuthor, ChatPerson } from "@/components/chat";

function PersonAvatar({ person }: { person: ChatPerson }) {
	return (
		<span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-landing-button text-xs font-semibold text-landing-secondary">
			{person.photo ? (
				<img src={person.photo} alt="" className="size-full object-cover" />
			) : (
				<span aria-hidden>{person.initials}</span>
			)}
		</span>
	);
}

function AuthorAvatar({ author }: { author: ChatAuthor }) {
	if (author.kind === "person") return <PersonAvatar person={author} />;
	return <StillBotFace {...author.look} className="size-7" />;
}

/** The author's name, the app's "Bot" chip for a bot, and when they said it, as a message row heads its text. */
function MessageByline({ name, time, isBot }: { name: string; time: string; isBot: boolean }) {
	return (
		<span className="flex items-center gap-2">
			<span className="text-sm font-semibold text-landing-text">{name}</span>
			{isBot && (
				<span className="rounded bg-landing-chip px-1.25 py-px text-xs/snug font-semibold text-landing-muted">
					Bot
				</span>
			)}
			<span className="text-xs text-landing-faint">{time}</span>
		</span>
	);
}

interface MessageRowProps {
	author: ChatAuthor;
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
				<MessageByline name={author.name} time={time} isBot={author.kind === "bot"} />
				<p className="text-sm/normal text-pretty text-landing-message">{text}</p>
				{children}
			</div>
		</div>
	);
}

/** How a message arrives in a demo: a short fade and rise. */
export const arrive =
	"animate-in fade-in slide-in-from-bottom-1.5 duration-260 ease-landing motion-reduce:animate-none";
