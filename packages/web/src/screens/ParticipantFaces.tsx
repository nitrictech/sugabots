import type { ThreadParticipant } from "@sugabots/contracts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";

/** How far each face in the stack sits over the one before it, as a share of its size. */
const OVERLAP = 0.3;

/** The ring round each face, so it reads apart from the one under it. */
const RING_WIDTH_PX = 2;

/**
 * The faces of who is in a thread, overlapping in a row: people first, then
 * bots, each in the order given, the first `shown` of them and then how many
 * more. Every face, and the count, sits over the one before it the same way,
 * ringed in `surface`, the colour of what the stack is on. For decoration
 * only: whatever holds it names who is in the thread.
 */
export function ParticipantFaces({
	participants,
	shown = 4,
	size = 20,
	surface = "var(--background)",
}: {
	participants: readonly ThreadParticipant[];
	/** How many faces show before the rest are counted. */
	shown?: number;
	size?: number;
	/** A CSS colour: the surface the stack sits on. */
	surface?: string;
}) {
	const ordered = [
		...participants.filter((participant) => participant.kind === "person"),
		...participants.filter((participant) => participant.kind === "agent"),
	];
	const faces = ordered.slice(0, shown);
	const hidden = ordered.length - faces.length;
	const overlapPx = Math.round(size * OVERLAP);
	const ring = `0 0 0 ${RING_WIDTH_PX}px ${surface}`;
	// Each is positioned, so a later face paints over an earlier one whatever draws it.
	const place = (index: number) => ({
		position: "relative" as const,
		marginLeft: index === 0 ? 0 : -overlapPx,
	});
	return (
		<span aria-hidden className="flex shrink-0 items-center">
			{faces.map((participant, index) =>
				participant.kind === "agent" ? (
					<span key={participant.id} className="flex" style={place(index)}>
						<AgentAvatar
							color={participant.color}
							face={participant.face}
							shape={participant.shape}
							size={size}
							ringed={{ color: surface, width: RING_WIDTH_PX }}
						/>
					</span>
				) : (
					<span
						key={participant.id}
						className="flex rounded-full"
						style={{ ...place(index), boxShadow: ring }}
					>
						<PersonAvatar person={participant} size={size} />
					</span>
				),
			)}
			{hidden > 0 && (
				<span
					className="grid shrink-0 place-items-center rounded-full bg-chip font-semibold text-muted-foreground"
					style={{
						...place(faces.length),
						width: size,
						height: size,
						fontSize: Math.max(9, Math.round(size * 0.45)),
						boxShadow: ring,
					}}
				>
					+{hidden}
				</span>
			)}
		</span>
	);
}
