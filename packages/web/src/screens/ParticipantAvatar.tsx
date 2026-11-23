import type { Participant } from "@sugabots/contracts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";

/** Somebody in a conversation as their face: a bot's in its look, a person's picture or initials. */
export function ParticipantAvatar({
	participant,
	size,
}: {
	participant: Participant;
	size: number;
}) {
	return participant.kind === "bot" ? (
		<BotAvatar
			color={participant.color}
			face={participant.face}
			shape={participant.shape}
			size={size}
		/>
	) : (
		<PersonAvatar person={participant} size={size} />
	);
}
