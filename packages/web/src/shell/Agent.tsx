import { BotFace } from "@sugabots/avatars";
import type { AgentColor, AgentFace, AgentShape } from "@sugabots/contracts";
import { cn } from "cn";
import { Globe } from "lucide-react";

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
	/**
	 * Whether the bot stands for an external agent, which marks the corner of
	 * its face the way a chat app marks a person from outside the workspace.
	 */
	external?: boolean | undefined;
	/**
	 * Whether it stands for an agent on somebody's computer that isn't
	 * connected now: drawn faded and grey, badge and all, at every size.
	 */
	offline?: boolean | undefined;
	className?: string;
}

/** How an offline bot's face is drawn. */
const OFFLINE = "opacity-55 grayscale";

/** The surface colour round a face that overlaps something, following the head's shape. */
const RING = { color: "var(--panel)", width: 3 };

/** Below this size the external badge would be a speck; the name's tag says it instead. */
const SMALLEST_BADGED_SIZE = 20;

export function AgentAvatar({
	color,
	face = "pill",
	shape,
	size = 32,
	ringed = false,
	external = false,
	offline = false,
	className: givenClassName,
}: AgentAvatarProps) {
	const className = cn(offline && OFFLINE, givenClassName) || undefined;
	const ring = ringed === true ? RING : ringed || undefined;
	const botFace = (
		<BotFace
			color={color}
			face={face}
			shape={shape}
			width={size}
			height={size}
			ring={ring}
			className={external ? undefined : className}
		/>
	);
	if (!external || size < SMALLEST_BADGED_SIZE) return botFace;
	const badge = externalBadgeGeometry(size);
	// A real hole rather than a ring painted in the surface's colour, so it
	// stays right on any surface, and on a row's hover colour too.
	const notch = `radial-gradient(circle ${badge.size / 2 + badge.gap}px at ${badge.center}px ${badge.center}px, transparent 98%, #000 100%)`;
	return (
		<span className={cn("relative inline-flex", className)}>
			<span className="inline-flex" style={{ maskImage: notch, WebkitMaskImage: notch }}>
				{botFace}
			</span>
			<span
				aria-hidden
				className="absolute grid place-items-center rounded-full bg-foreground text-background"
				style={{
					width: badge.size,
					height: badge.size,
					left: badge.center - badge.size / 2,
					top: badge.center - badge.size / 2,
				}}
			>
				<Globe size={Math.round(badge.size * 0.66)} strokeWidth={2.4} />
			</span>
		</span>
	);
}

/**
 * Where the external badge sits on a face of `faceSize`: its size, the gap
 * cut round it, and its centre, measured from the face's top left on both
 * axes, so it overhangs the bottom-right corner a little.
 */
function externalBadgeGeometry(faceSize: number) {
	const size = Math.max(11, Math.round(faceSize * 0.38));
	const gap = Math.max(1.5, Math.round(faceSize * 0.05));
	return { size, gap, center: faceSize - size / 2 + gap };
}

/**
 * The small tag beside a bot's name that says it is one: "External bot" for
 * one standing for an external agent, which answers with its own tools rather
 * than the pod's.
 */
export function BotTag({ external = false }: { external?: boolean }) {
	return (
		<span className="shrink-0 rounded-[4px] bg-chip px-[5px] py-px font-semibold text-[10.5px] text-muted-foreground leading-[1.4]">
			{external ? "External bot" : "Bot"}
		</span>
	);
}
