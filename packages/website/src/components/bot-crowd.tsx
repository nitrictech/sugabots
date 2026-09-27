import { botCrowd } from "@sugabots/avatars";
import { BotAvatar } from "@/components/bot-avatar";
import { Reveal, RevealItem } from "@/components/reveal";

/** The face size the crowd's lifts are measured at. */
const CROWD_FACE_PX = 40;

/**
 * The bot crowd, drawn inline so each face can pop in. Faces are 40px on one
 * row and shrink together where the row doesn't fit; lifts scale with them.
 */
export function BotCrowd() {
	return (
		<Reveal
			stagger={0.05}
			className="grid max-w-94 grid-cols-8 items-center gap-2 py-2.5"
			aria-hidden
		>
			{botCrowd.map(({ rotate, lift, ...look }) => (
				<RevealItem
					key={look.color}
					variant="pop"
					style={{ rotate, y: `${(-lift / CROWD_FACE_PX) * 100}%` }}
				>
					<BotAvatar {...look} className="aspect-square h-auto w-full" />
				</RevealItem>
			))}
		</Reveal>
	);
}
