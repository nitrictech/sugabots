import { BotFace, type LivelyBehaviour, LivelyBotFace } from "@sugabots/avatars";
import type { AgentColor, AgentFace, AgentShape } from "@sugabots/contracts";

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
