import {
	BotFace,
	type BotLook,
	defaultLiveliness,
	LivelinessContext,
	LivelyBotFace,
	type LivelyFace,
} from "@sugabots/avatars";
import { cn } from "cn";
import { motion } from "motion/react";
import { useRef } from "react";
import { Reveal, riseIn } from "@/components/reveal";

interface PeekingBot {
	look: BotLook;
	/** Its size, and how far below the edge it sits, as Tailwind classes: never past its eyes. */
	place: string;
}

/**
 * A row of bots of different sizes, tallest in the middle, rising out of the
 * page's bottom edge. Narrower screens show the middle five.
 */
const peekingBots: readonly PeekingBot[] = [
	{
		look: { color: "rose", face: "dot", shape: "flower" },
		place: "hidden xl:block xl:size-24 xl:translate-y-1/4",
	},
	{
		look: { color: "amber", face: "wink", shape: "bowl" },
		place: "size-11 translate-y-1/4 sm:size-22 lg:size-32 lg:translate-y-3/10",
	},
	{
		look: { color: "sky", face: "arc", shape: "pebble" },
		place: "size-16 translate-y-3/10 sm:size-28 lg:size-40",
	},
	{
		look: { color: "purple", face: "pill", shape: "hexagon" },
		place: "size-24 translate-y-1/4 sm:size-44 lg:size-64",
	},
	{
		look: { color: "green", face: "dot", shape: "leaf" },
		place: "size-18 translate-y-2/9 sm:size-26 lg:size-36",
	},
	{
		look: { color: "orange", face: "square", shape: "ghost" },
		place: "size-13 translate-y-2/7 sm:size-20 lg:size-28",
	},
	{
		look: { color: "pink", face: "arc", shape: "star" },
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
					<PeekingBotFace key={bot.look.color} {...bot} />
				))}
			</Reveal>
		</LivelinessContext>
	);
}

/** One of the row: it watches the pointer, and hops when the pointer touches its head. */
function PeekingBotFace({ look, place }: PeekingBot) {
	const face = useRef<LivelyFace>(null);
	return (
		<motion.div
			variants={riseIn}
			className={cn("pointer-events-none relative shrink-0", place)}
			onPointerEnter={() => face.current?.play("hop")}
		>
			<LivelyBotFace {...look} watchPointer ref={face} className="size-full" />
			{/*
			 * An unseen copy of the head that takes the pointer where it's painted. It
			 * stays put as the head hops, so the head doesn't slip out from under the pointer.
			 */}
			<BotFace
				{...look}
				className="absolute inset-0 size-full opacity-0 [&_*]:pointer-events-auto"
			/>
		</motion.div>
	);
}
