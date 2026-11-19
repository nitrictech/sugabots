import type { Participant } from "@sugabots/contracts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";

/** Somebody in a conversation as their face: a bot's in its look, a person's picture or initials. */
export function ParticipantAvatar({
	participant,
	size,
	className,
}: {
	participant: Participant;
	size: number;
	className?: string;
}) {
	return participant.kind === "bot" ? (
		<BotAvatar
			color={participant.color}
			face={participant.face}
			shape={participant.shape}
			size={size}
			className={className}
		/>
	) : (
		<PersonAvatar person={participant} size={size} className={className} />
	);
}
