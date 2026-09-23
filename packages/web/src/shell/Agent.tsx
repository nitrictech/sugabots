import type { AgentFace } from "@sugabots/contracts";
import { cn } from "cn";

/*
 * An agent's identity: its face and its name.
 *
 * Both are self-sufficient — each sets `agent-tint` and the hue on itself
 * rather than inheriting them. That is deliberate: the right panel is a sibling
 * of the main pane rather than a child, a collaboration shows two agents of
 * different hues side by side, and a sidebar row lists a different agent on
 * every line. Anything that leaned on an ancestor for the colour would be wrong
 * in at least one of those places — and was.
 */

interface AgentAvatarProps {
	hue: number;
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
	hue,
	face = "bar",
	size = 32,
	ringed = false,
	className,
}: AgentAvatarProps) {
	return (
		<svg
			aria-hidden
			viewBox="0 0 40 40"
			width={size}
			height={size}
			className={cn("agent-tint shrink-0", className)}
			style={{ ["--agent-hue" as string]: hue }}
		>
			<circle
				cx="20"
				cy="20"
				r={ringed ? 18.5 : 20}
				fill="var(--agent-fill)"
				stroke={ringed ? "var(--card)" : undefined}
				strokeWidth={ringed ? 3 : undefined}
			/>
			<Eyes face={face} />
		</svg>
	);
}

function Eyes({ face }: { face: AgentFace }) {
	const ink = "var(--agent-ink)";

	if (face === "dots") {
		return (
			<>
				<circle cx="14" cy="20" r="3.8" fill={ink} />
				<circle cx="26" cy="20" r="3.8" fill={ink} />
			</>
		);
	}

	if (face === "smile") {
		return (
			<path
				d="M10.5 21.5a3.5 3.5 0 0 1 7 0M22.5 21.5a3.5 3.5 0 0 1 7 0"
				stroke={ink}
				strokeWidth="2.6"
				strokeLinecap="round"
				fill="none"
			/>
		);
	}

	const radius = face === "square" ? 1.5 : 3.5;
	return (
		<>
			<rect x="10" y="15" width="7" height="11" rx={radius} fill={ink} />
			<rect x="23" y="15" width="7" height="11" rx={radius} fill={ink} />
		</>
	);
}
