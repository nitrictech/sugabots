import { BotFace } from "@sugabots/avatars";
import type { AgentColor, AgentFace } from "@sugabots/contracts";
import { cn } from "cn";

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
	size?: number;
	/**
	 * A ring in the surface colour, for a face that overlaps something — the
	 * corner of its own message bubble, or the next face in a stack.
	 */
	ringed?: boolean;
	className?: string;
}

export function AgentAvatar({
	color,
	face = "pill",
	size = 32,
	ringed = false,
	className,
}: AgentAvatarProps) {
	return (
		<BotFace
			color={color}
			face={face}
			width={size}
			height={size}
			className={cn(ringed && "rounded-full shadow-[0_0_0_3px_var(--panel)]", className)}
		/>
	);
}
