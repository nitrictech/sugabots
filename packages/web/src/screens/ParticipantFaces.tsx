import type { Participant } from "@sugabots/contracts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";

/** How far each face in the stack sits over the one before it, as a share of its size. */
const OVERLAP = 0.3;

/** The ring round each face, so it reads apart from the one under it. */
const RING_WIDTH_PX = 2;

/** The count of those not shown: its figures as a share of its size, and never smaller than this. */
const COUNT_FONT = { share: 0.45, minimumPx: 9 };

/**
 * The faces of who is in a conversation, overlapping in a row: people first, then
 * bots, each in the order given, the first `shown` of them and then how many
 * more. Every face, and the count, sits over the one before it the same way,
 * ringed in `surface`, the colour of what the stack is on. For decoration
 * only: whatever holds it names who is in the conversation.
 */
export function ParticipantFaces({
	participants,
	shown,
	size,
	surface = "var(--background)",
}: {
	participants: readonly Participant[];
	/** How many faces show before the rest are counted. */
	shown: number;
	size: number;
	/** A CSS colour: the surface the stack sits on. */
	surface?: string;
}) {
	const ordered = [
		...participants.filter((participant) => participant.kind === "person"),
		...participants.filter((participant) => participant.kind === "bot"),
	];
	const faces = ordered.slice(0, shown);
	const hidden = ordered.length - faces.length;
	const overlapPx = Math.round(size * OVERLAP);
	const ring = `0 0 0 ${RING_WIDTH_PX}px ${surface}`;
	// Each is positioned (`relative`), so a later face paints over an earlier one whatever draws it.
	const place = (index: number) => ({ marginLeft: index === 0 ? 0 : -overlapPx });
	return (
		<span aria-hidden className="flex shrink-0 items-center">
			{faces.map((participant, index) =>
				participant.kind === "bot" ? (
					<span key={participant.id} className="relative flex" style={place(index)}>
						<BotAvatar
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
						className="relative flex rounded-full"
						style={{ ...place(index), boxShadow: ring }}
					>
						<PersonAvatar person={participant} size={size} />
					</span>
				),
			)}
			{hidden > 0 && (
				<span
					className="relative grid shrink-0 place-items-center rounded-full bg-chip font-semibold text-muted-foreground"
					style={{
						...place(faces.length),
						width: size,
						height: size,
						fontSize: Math.max(COUNT_FONT.minimumPx, Math.round(size * COUNT_FONT.share)),
						boxShadow: ring,
					}}
				>
					+{hidden}
				</span>
			)}
		</span>
	);
}
