import { botColorVariables } from "@sugabots/avatars";
import type { AgentParticipant, PersonParticipant } from "@sugabots/contracts";
import { cn } from "cn";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";

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

/** The most faces stacked; the label counts the rest as "others". */
const MAX_FACES = 3;

/**
 * Who is typing: their faces, stacked, beside a bubble of three dots where the
 * next message will land. A bot alone keeps its own tint; anyone else, or a
 * bot with company, gets the bubble other people's messages have. What a bot
 * is doing meanwhile is the tool line above.
 */
export function TypingIndicator({
	typers,
	outgoing = false,
	compact = false,
}: {
	typers: readonly [Typer, ...Typer[]];
	/** Drawn on the right, where this bot's messages are. */
	outgoing?: boolean;
	/** The sidebar's smaller faces. */
	compact?: boolean;
}) {
	const [first] = typers;
	const lonelyBot = typers.length === 1 && first.kind === "agent" ? first : undefined;
	const size = compact ? 26 : 34;
	return (
		<div
			role="status"
			aria-label={typingLabel(typers)}
			className={cn("flex items-end gap-2 pt-3.5", outgoing && "flex-row-reverse")}
			style={lonelyBot && botColorVariables(lonelyBot.color)}
		>
			<span className="flex shrink-0">
				{typers.slice(0, MAX_FACES).map((typer, index) => (
					<Face
						key={`${typer.kind}:${typer.id}`}
						typer={typer}
						size={size}
						className={cn(
							index > 0 && "rounded-full shadow-[0_0_0_2px_var(--background)]",
							index > 0 && (compact ? "-ml-1.5" : "-ml-2"),
						)}
					/>
				))}
			</span>
			<span
				className={cn(
					"px-[15px] py-[13px]",
					lonelyBot ? "bg-bot-tint text-bot-mono" : "bg-bubble-human text-muted-foreground",
					outgoing ? "rounded-[20px_20px_6px_20px]" : "rounded-[20px_20px_20px_6px]",
				)}
			>
				<span aria-hidden className="typing-dots">
					<i />
					<i />
					<i />
				</span>
			</span>
		</div>
	);
}

function Face({ typer, size, className }: { typer: Typer; size: number; className?: string }) {
	return typer.kind === "agent" ? (
		<AgentAvatar color={typer.color} face={typer.face} size={size} className={className} />
	) : (
		<PersonAvatar person={typer} size={size} className={className} />
	);
}

/** "Ana is typing", "Ana and Ben are typing", "Ana, Ben and 2 others are typing". */
function typingLabel(typers: readonly [Typer, ...Typer[]]): string {
	const names = typers.map((typer) => typer.name);
	if (names.length === 1) return `${names[0]} is typing`;
	if (names.length <= MAX_FACES) {
		return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are typing`;
	}
	const named = names.slice(0, MAX_FACES - 1);
	return `${named.join(", ")} and ${names.length - named.length} others are typing`;
}
