import type { BotLook } from "@sugabots/avatars";
import { cn } from "cn";
import { CheckIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { AnimatePresence } from "motion/react";
import type { ComponentProps, ReactNode } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { RevealItem } from "@/components/reveal";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

/*
 * A conversation drawn the way the app draws one: each message is a row with
 * its author's face, name and time at the head, and its words under them,
 * everyone's on the same side.
 */

/** Who wrote a message: a bot with its face, or a person with their initials. */
export type ChatAuthor =
	| { kind: "bot"; name: string; look: BotLook }
	| { kind: "person"; name: string; initials: string };

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
			<AvatarFallback className="bg-secondary text-xs font-bold text-secondary-foreground">
				{author.initials}
			</AvatarFallback>
		</Avatar>
	);
}

interface ChatMessageProps {
	author: ChatAuthor;
	/** When it was sent, beside the name, e.g. "7:12 PM". */
	time?: string;
	className?: string;
	/** Its words, then anything it opened, like a collaboration. */
	children: ReactNode;
}

/** One message as a row: the author's face, their name, a Bot tag for a bot, the time, and the message. */
export function ChatMessage({ author, time, className, children }: ChatMessageProps) {
	return (
		<article className={cn("flex gap-3", className)}>
			<span aria-hidden className="mt-0.5 flex shrink-0">
				<ChatAvatar author={author} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
				<div className="flex items-center gap-2">
					<span className="text-[15px] font-semibold">{author.name}</span>
					{author.kind === "bot" && (
						<span className="rounded-[4px] bg-muted px-[5px] py-px text-[10.5px] leading-[1.4] font-semibold text-muted-foreground">
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
			className={cn("self-stretch text-[15px] leading-normal text-pretty break-words", className)}
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

/** Under a routine's result: the routine it came from. */
export function ChatRoutineNote({ routine }: { routine: string }) {
	return (
		<p className="flex items-center gap-0.5 pt-1 text-xs font-medium text-muted-foreground">
			From {routine}
			<ChevronRightIcon aria-hidden className="size-3" strokeWidth={2.4} />
		</p>
	);
}

/** Where the conversation moves on to a new day: a rule either side of "Today" or the date. */
export function ChatDay({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-center gap-3">
			<span aria-hidden className="h-px flex-1 bg-border" />
			<span className="text-xs font-semibold text-muted-foreground">{children}</span>
			<span aria-hidden className="h-px flex-1 bg-border" />
		</div>
	);
}

interface ChatCollaborationProps {
	from: BotLook;
	to: { name: string; look: BotLook };
	/** When the other bot last wrote in it, e.g. "9:05am". */
	lastReply?: string;
	/** Where it stands, e.g. "Done". */
	status: string;
}

/**
 * The collaboration a bot's message opened with another bot, as a thread line
 * under its words. The faces are ringed in the card's colour, which every demo
 * chat sits on, so the ring only shows where they overlap.
 */
export function ChatCollaboration({ from, to, lastReply, status }: ChatCollaborationProps) {
	return (
		<div className="mt-1 flex max-w-full items-center gap-2 py-1">
			<span aria-hidden className="flex shrink-0">
				{[from, to.look].map((look) => (
					<BotAvatar
						key={`${look.color}-${look.face}`}
						size="xs"
						className="-mr-[7px] shadow-[0_0_0_2px_var(--card)]"
						{...look}
					/>
				))}
			</span>
			<span className="truncate pl-2 text-[13px] font-semibold text-link">
				Collaboration with {to.name}
			</span>
			{lastReply && (
				<span className="shrink-0 text-[12.5px] text-muted-foreground">Last reply {lastReply}</span>
			)}
			<span className="shrink-0 rounded-[5px] bg-muted px-1.5 py-px text-[11.5px] font-semibold text-muted-foreground">
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
			className="mt-1.5 mb-1 flex w-full max-w-[460px] flex-col gap-2.5 rounded-[6px_20px_20px_20px] border bg-background py-2.5 pr-3 pl-2.5"
		>
			<div className="flex items-start gap-2.5">
				<span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-secondary text-xs font-bold text-secondary-foreground">
					{mark}
				</span>
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="text-xs text-muted-foreground">{who}</span>
					<span className="text-sm font-medium [overflow-wrap:anywhere]">{action}</span>
				</span>
			</div>
			<div className="ml-[34px]">
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
