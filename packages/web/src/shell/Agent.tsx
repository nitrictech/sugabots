import { BotFace } from "@sugabots/avatars";
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

interface AgentAvatarProps {
	color: AgentColor;
	face?: AgentFace;
	shape: AgentShape;
	size?: number;
	/**
	 * A ring in the surface colour, for a face that overlaps something — the
	 * corner of its own message bubble, or the next face in a stack. `true` is
	 * the panel's colour; a face on another surface names that surface's.
	 */
	ringed?: boolean | { color: string; width: number };
	className?: string;
}

/** The surface colour round a face that overlaps something, following the head's shape. */
const RING = { color: "var(--panel)", width: 3 };

export function AgentAvatar({
	color,
	face = "pill",
	shape,
	size = 32,
	ringed = false,
	className,
}: AgentAvatarProps) {
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
