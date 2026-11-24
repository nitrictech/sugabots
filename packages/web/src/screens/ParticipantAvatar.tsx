import type { Participant } from "@sugabots/contracts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { MemberAvatar } from "@/ui/avatar.tsx";

/** Somebody in a chat as their face: a bot's in its look, a member's picture or initials. */
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
			eyes={participant.eyes}
			shape={participant.shape}
			size={size}
		/>
	) : (
		<MemberAvatar member={participant} size={size} />
	);
}
