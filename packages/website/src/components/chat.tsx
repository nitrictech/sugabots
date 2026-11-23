import type { AvatarParts } from "@sugabots/avatars";
import { cn } from "cn";
import { CheckIcon, XIcon } from "lucide-react";
import { AnimatePresence } from "motion/react";
import type { ComponentProps, ReactNode } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { RevealItem } from "@/components/reveal";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

/*
 * A chat drawn the way the app draws one: each message is a row with
 * its author's face, name and time at the head, and its words under them,
 * everyone's on the same side.
 */

export interface ChatBot {
	kind: "bot";
	name: string;
	look: AvatarParts;
}

interface ChatPerson {
	kind: "person";
	name: string;
	initials: string;
	/** A licensed photo, which the landing page's demos show in place of the initials. */
	photo?: string;
}

/** Who wrote a message: a bot with its face, or a person. */
export type ChatAuthor = ChatBot | ChatPerson;

/** A bot's face, or a person's photo or initials. */
export function ChatAvatar({
	author,
	size,
}: {
	author: ChatAuthor;
	size?: ComponentProps<typeof Avatar>["size"];
}) {
	if (author.kind === "bot") return <BotAvatar size={size} {...author.look} />;
	return (
		<Avatar size={size}>
			{author.photo && <AvatarImage src={author.photo} alt="" />}
			<AvatarFallback className="bg-secondary text-xs font-bold text-secondary-foreground">
				{author.initials}
			</AvatarFallback>
		</Avatar>
	);
}

interface ChatMessageProps {
	author: ChatAuthor;
	avatarSize?: ComponentProps<typeof Avatar>["size"];
	/** When it was sent, beside the name, e.g. "7:12 PM". */
	time?: string;
	className?: string;
	/** Its words, then anything it opened, like a collaboration. */
	children: ReactNode;
}

/** One message as a row: the author's face, their name, a Bot tag for a bot, the time, and the message. */
export function ChatMessage({ author, avatarSize, time, className, children }: ChatMessageProps) {
	return (
		<article className={cn("flex gap-3", className)}>
			<span aria-hidden className="mt-0.5 flex shrink-0">
				<ChatAvatar author={author} size={avatarSize} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
				<div className="flex items-center gap-2">
					<span className="text-sm font-semibold">{author.name}</span>
					{author.kind === "bot" && (
						<span className="rounded bg-muted px-1.25 py-px text-xs leading-snug font-semibold text-muted-foreground">
							Bot
						</span>
					)}
					{time && <span className="text-xs text-muted-foreground">{time}</span>}
				</div>
				{children}
			</div>
		</article>
	);
}

/** A message's words. */
export function ChatText({ className, ...props }: ComponentProps<"p">) {
	return (
		<p
			className={cn("self-stretch text-sm leading-normal text-pretty break-words", className)}
			{...props}
		/>
	);
}

/** What a bot used on the way to its reply, above its words: "Used Sheets for 3s". */
export function ChatToolLine({ className, ...props }: ComponentProps<"p">) {
	return (
		<p className={cn("pb-1 text-sm font-medium text-muted-foreground", className)} {...props} />
	);
}

interface ChatCollaborationProps {
	from: AvatarParts;
	to: { name: string; look: AvatarParts };
	/** When the other bot last wrote in it, e.g. "9:05am". */
	lastReply?: string;
	/** Where it stands, e.g. "Done". */
	status: string;
}

/**
 * The collaboration a bot's message opened with another bot, as a line
 * under its words. The faces are ringed in the card's colour, which every demo
 * chat sits on, so the ring only shows where they overlap.
 */
export function ChatCollaboration({ from, to, lastReply, status }: ChatCollaborationProps) {
	return (
		<div className="mt-1 flex max-w-full items-center gap-2 py-1">
			<span aria-hidden className="flex shrink-0">
				{[from, to.look].map((look) => (
					<BotAvatar
						key={`${look.color}-${look.eyes}`}
						size="xs"
						className="-mr-1.75 ring-2 ring-card"
						{...look}
					/>
				))}
			</span>
			<span className="truncate pl-2 text-xs font-semibold text-link">
				Collaboration with {to.name}
			</span>
			{lastReply && (
				<span className="shrink-0 text-xs text-muted-foreground">Last reply {lastReply}</span>
			)}
			<span className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-xs font-semibold text-muted-foreground">
				{status}
			</span>
		</div>
	);
}

export type ApprovalDecision = "pending" | "allowed" | "denied";

interface ChatApprovalProps {
	/** What the request is for, e.g. "Trip Planner wants to use Flights". */
	who: string;
	/** What would happen, e.g. "Book 4 seats". */
	action: string;
	/** The app's mark, beside who wants to use it. */
	mark: ReactNode;
	decision: ApprovalDecision;
	/** What became of it once answered either way, e.g. "Allowed by you". */
	outcomes: Record<Exclude<ApprovalDecision, "pending">, string>;
	onDecide: (decision: Exclude<ApprovalDecision, "pending">) => void;
}

/** A write a bot wants to make, held under its words for someone to allow or deny, and what became of it. */
export function ChatApproval({
	who,
	action,
	mark,
	decision,
	outcomes,
	onDecide,
}: ChatApprovalProps) {
	return (
		<section
			aria-label={`Approval request: ${action}`}
			className="mt-1.5 mb-1 flex w-full max-w-115 flex-col gap-2.5 rounded-3xl border bg-background py-2.5 pr-3 pl-2.5"
		>
			<div className="flex items-start gap-2.5">
				<span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-bold text-secondary-foreground">
					{mark}
				</span>
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="text-xs text-muted-foreground">{who}</span>
					<span className="text-sm font-medium wrap-anywhere">{action}</span>
				</span>
			</div>
			<div className="ml-8.5">
				<AnimatePresence mode="wait" initial={false}>
					<RevealItem key={decision} initial="hidden" animate="visible" exit="hidden">
						{decision === "pending" ? (
							<div className="flex gap-2">
								<Button variant="brand" size="sm" onClick={() => onDecide("allowed")}>
									Allow
								</Button>
								<Button variant="secondary" size="sm" onClick={() => onDecide("denied")}>
									Deny
								</Button>
							</div>
						) : (
							<p role="status" className="flex items-start gap-1.5 text-xs text-muted-foreground">
								{decision === "allowed" ? (
									<CheckIcon aria-hidden className="mt-0.5 size-3 shrink-0" strokeWidth={2.8} />
								) : (
									<XIcon aria-hidden className="mt-0.5 size-3 shrink-0" strokeWidth={2.8} />
								)}
								{outcomes[decision]}
							</p>
						)}
					</RevealItem>
				</AnimatePresence>
			</div>
		</section>
	);
}
