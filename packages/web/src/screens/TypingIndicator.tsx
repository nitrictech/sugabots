import type { AgentParticipant, PersonParticipant } from "@sugabots/contracts";
import { cn } from "cn";
import { listNames } from "@/lib/name-list.ts";

/** Somebody the indicator shows: a bot at work on its reply, or a person writing in the composer. */
export type Typer =
	| Pick<AgentParticipant, "kind" | "id" | "name" | "color" | "face">
	| Pick<PersonParticipant, "kind" | "id" | "name" | "email" | "image">;

/** Whether there is anybody to show, which `TypingIndicator` needs. */
export function anyoneTyping<T extends Typer>(
	typers: readonly T[],
): typers is readonly [T, ...T[]] {
	return typers.length > 0;
}

/**
 * Who is typing, as one quiet line of three moving dots and their names. What
 * a bot is doing meanwhile is the tool line above.
 */
export function TypingIndicator({
	typers,
	className,
}: {
	typers: readonly [Typer, ...Typer[]];
	/** Merged over its own; its inset is a message row's by default, so it lines up with the messages. */
	className?: string;
}) {
	const label = typingLabel(typers);
	return (
		<div
			role="status"
			aria-label={label}
			className={cn(
				"flex h-[26px] items-center gap-2 px-5 font-medium text-[12.5px] text-muted-foreground",
				className,
			)}
		>
			<span aria-hidden className="typing-dots typing-dots-small">
				<i />
				<i />
				<i />
			</span>
			<span aria-hidden>{label}</span>
		</div>
	);
}

/** "Ana is typing", "Ana and Ben are typing", "Ana, Ben and 2 others are typing". */
function typingLabel(typers: readonly [Typer, ...Typer[]]): string {
	return `${listNames(typers.map((typer) => typer.name))} ${typers.length === 1 ? "is" : "are"} typing`;
}
