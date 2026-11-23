import {
	type LivelyBehaviour,
	LivelyBotFace,
	type LivelyFace,
	StillBotFace,
	useGroupTurn,
	useMoodLoop,
	WATCHING_MOODS,
} from "@sugabots/avatars";
import type { BotColor, BotFace, BotShape } from "@sugabots/contracts";
import type { Ref } from "react";

/*
 * A bot's face.
 *
 * It takes its colour as a prop rather than from an ancestor. That is
 * deliberate: the right panel is a sibling of the main pane rather than a
 * child, a collaboration shows two bots of different colours side by side,
 * and a list shows a different bot on every row. Anything that leaned on an
 * ancestor for the colour would be wrong in at least one of those places.
 */

type BotAvatarProps = {
	color: BotColor;
	face?: BotFace;
	shape: BotShape;
	size?: number;
	className?: string;
} & (
	| {
			/**
			 * A ring in `color`, the surface's, for a face that overlaps something,
			 * such as the next face in a stack. It follows the head's shape.
			 */
			ringed?: { color: string; width: number };
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

export function BotAvatar({
	color,
	face = "pill",
	shape,
	size = 32,
	ringed,
	lively,
	className,
}: BotAvatarProps) {
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
		<StillBotFace
			color={color}
			face={face}
			shape={shape}
			width={size}
			height={size}
			ring={ringed}
			className={className}
		/>
	);
}

/** A bot's look: what `BotAvatar` draws. */
interface BotLook {
	color: BotColor;
	face: BotFace;
	shape: BotShape;
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
}: {
	bot: BotLook;
	size: number;
	busy: boolean;
	watching: boolean;
}) {
	const watchingMood = useMoodLoop(WATCHING_MOODS, watching && !busy);
	const mood = busy ? "thinking" : watching ? watchingMood : "still";
	return (
		<BotAvatar
			color={bot.color}
			face={bot.face}
			shape={bot.shape}
			size={size}
			lively={{ mood, watchPointer: true, watchTyping: true }}
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
}: {
	bot: BotLook;
	size: number;
	faceRef: Ref<LivelyFace>;
}) {
	const movingTurn = useGroupTurn();
	return (
		<BotAvatar
			color={bot.color}
			face={bot.face}
			shape={bot.shape}
			size={size}
			lively={{ mood: movingTurn ? "idle" : "still", watchPointer: true, ref: faceRef }}
		/>
	);
}
