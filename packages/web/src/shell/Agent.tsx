import {
	BotFace,
	type LivelyBehaviour,
	LivelyBotFace,
	type LivelyFace,
	useGroupTurn,
	useMoodLoop,
} from "@sugabots/avatars";
import type { AgentColor, AgentFace, AgentShape } from "@sugabots/contracts";
import type { Ref } from "react";
import { WATCHING_MOODS } from "@/lib/face-moods.ts";

/*
 * An agent's face.
 *
 * It takes its colour as a prop rather than from an ancestor. That is
 * deliberate: the right panel is a sibling of the main pane rather than a
 * child, a collaboration shows two agents of different colours side by side,
 * and a list shows a different agent on every row. Anything that leaned on an
 * ancestor for the colour would be wrong in at least one of those places.
 */

type AgentAvatarProps = {
	color: AgentColor;
	face?: AgentFace;
	shape: AgentShape;
	size?: number;
	className?: string;
} & (
	| {
			/**
			 * A ring in the surface colour, for a face that overlaps something — the
			 * corner of its own message bubble, or the next face in a stack. `true` is
			 * the panel's colour; a face on another surface names that surface's.
			 */
			ringed?: boolean | { color: string; width: number };
			lively?: never;
	  }
	| {
			/**
			 * Brings the face to life, as `LivelyBotFace` describes. Faces in a list
			 * should mostly be `still`, taking turns to move in a `LivelyGroup`.
			 */
			lively: LivelyBehaviour;
			ringed?: never;
	  }
);

/** The surface colour round a face that overlaps something, following the head's shape. */
const RING = { color: "var(--panel)", width: 3 };

export function AgentAvatar({
	color,
	face = "pill",
	shape,
	size = 32,
	ringed = false,
	lively,
	className,
}: AgentAvatarProps) {
	if (lively) {
		return (
			<LivelyBotFace
				color={color}
				face={face}
				shape={shape}
				width={size}
				height={size}
				{...lively}
				className={className}
			/>
		);
	}
	return (
		<BotFace
			color={color}
			face={face}
			shape={shape}
			width={size}
			height={size}
			ring={ringed === true ? RING : ringed || undefined}
			className={className}
		/>
	);
}

/** A bot's look: what `AgentAvatar` draws. */
interface AgentLook {
	color: AgentColor;
	face: AgentFace;
	shape: AgentShape;
}

/**
 * The face of a bot someone is talking to: thinking while the bot is `busy`;
 * else, while `watching`, following the pointer and the typing; else still.
 */
export function WatchingAvatar({
	bot,
	size,
	busy,
	watching,
	className,
}: {
	bot: AgentLook;
	size: number;
	busy: boolean;
	watching: boolean;
	className?: string;
}) {
	const watchingMood = useMoodLoop(WATCHING_MOODS, watching && !busy);
	const mood = busy ? "thinking" : watching ? watchingMood : "still";
	return (
		<AgentAvatar
			color={bot.color}
			face={bot.face}
			shape={bot.shape}
			size={size}
			lively={{ mood, watchPointer: true, watchTyping: true }}
			className={className}
		/>
	);
}

/**
 * A bot's face among others in a `LivelyGroup`: still except on its turn to
 * move, and hopping when played through `faceRef`.
 */
export function TurnTakingAvatar({
	bot,
	size,
	faceRef,
	className,
}: {
	bot: AgentLook;
	size: number;
	faceRef: Ref<LivelyFace>;
	className?: string;
}) {
	const movingTurn = useGroupTurn();
	return (
		<AgentAvatar
			color={bot.color}
			face={bot.face}
			shape={bot.shape}
			size={size}
			lively={{ mood: movingTurn ? "idle" : "still", watchPointer: true, ref: faceRef }}
			className={className}
		/>
	);
}
