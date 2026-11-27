import {
	type AvatarParts,
	defaultLiveliness,
	LivelinessContext,
	LivelyBotFace,
	type LivelyFace,
	StillBotFace,
} from "@sugabots/avatars";
import { cn } from "cn";
import { motion } from "motion/react";
import { useRef } from "react";
import { Reveal, riseIn } from "@/components/reveal";

interface PeekingBot {
	avatar: AvatarParts;
	/** Its size, and how far below the edge it sits, as Tailwind classes: never past its eyes. */
	place: string;
}

/**
 * A row of bots of different sizes, tallest in the middle, rising out of the
 * page's bottom edge. Narrower screens show the middle five.
 */
const peekingBots: readonly PeekingBot[] = [
	{
		avatar: { color: "rose", eyes: "dot", shape: "flower" },
		place: "hidden xl:block xl:size-24 xl:translate-y-1/4",
	},
	{
		avatar: { color: "amber", eyes: "wink", shape: "bowl" },
		place: "size-11 translate-y-1/4 sm:size-24 lg:size-32 lg:translate-y-3/10",
	},
	{
		avatar: { color: "sky", eyes: "arc", shape: "pebble" },
		place: "size-16 translate-y-3/10 sm:size-28 lg:size-40",
	},
	{
		avatar: { color: "purple", eyes: "pill", shape: "hexagon" },
		place: "size-24 translate-y-1/4 sm:size-44 lg:size-64",
	},
	{
		avatar: { color: "green", eyes: "dot", shape: "leaf" },
		place: "size-20 translate-y-2/9 sm:size-28 lg:size-36",
	},
	{
		avatar: { color: "orange", eyes: "square", shape: "ghost" },
		place: "size-14 translate-y-2/7 sm:size-20 lg:size-28",
	},
	{
		avatar: { color: "pink", eyes: "arc", shape: "star" },
		place: "hidden xl:block xl:size-20 xl:translate-y-1/4",
	},
];

/** The end of the landing page: a row of bots peeking up over the footer's edge. */
export function PeekingBots() {
	return (
		// The site has no setting for it, so its bots move as much as the app's do by default.
		<LivelinessContext value={defaultLiveliness}>
			<Reveal
				stagger={0.1}
				delay={0.2}
				aria-hidden
				className="flex items-end justify-center gap-1 overflow-hidden pt-24 sm:gap-1.5 sm:pt-40"
			>
				{peekingBots.map((bot) => (
					<PeekingBotFace key={bot.avatar.color} {...bot} />
				))}
			</Reveal>
		</LivelinessContext>
	);
}

/** One of the row: it watches the pointer, and hops when the pointer touches its head. */
function PeekingBotFace({ avatar, place }: PeekingBot) {
	const face = useRef<LivelyFace>(null);
	return (
		<motion.div
			variants={riseIn}
			className={cn("pointer-events-none relative shrink-0", place)}
			onPointerEnter={() => face.current?.hop()}
		>
			<LivelyBotFace {...avatar} watchPointer ref={face} className="size-full" />
			{/*
			 * An unseen copy of the head that takes the pointer where it's painted. It
			 * stays put as the head hops, so the head doesn't slip out from under the pointer.
			 */}
			<StillBotFace
				{...avatar}
				className="absolute inset-0 size-full opacity-0 [&_*]:pointer-events-auto"
			/>
		</motion.div>
	);
}
