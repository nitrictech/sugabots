import { BotFace, type BotLook } from "@sugabots/avatars";
import { cn } from "cn";
import { motion } from "motion/react";
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
		place: "hidden xl:block xl:size-24 xl:translate-y-[24%]",
	},
	{
		look: { color: "amber", face: "wink", shape: "bowl" },
		place: "size-11 translate-y-[24%] sm:size-22 lg:size-32 lg:translate-y-[30%]",
	},
	{
		look: { color: "sky", face: "arc", shape: "pebble" },
		place: "size-16 translate-y-[30%] sm:size-28 lg:size-40",
	},
	{
		look: { color: "purple", face: "pill", shape: "hexagon" },
		place: "size-24 translate-y-[26%] sm:size-44 lg:size-64",
	},
	{
		look: { color: "green", face: "dot", shape: "leaf" },
		place: "size-18 translate-y-[22%] sm:size-26 lg:size-36",
	},
	{
		look: { color: "orange", face: "square", shape: "ghost" },
		place: "size-13 translate-y-[28%] sm:size-20 lg:size-28",
	},
	{
		look: { color: "pink", face: "arc", shape: "star" },
		place: "hidden xl:block xl:size-20 xl:translate-y-[26%]",
	},
];

const LIFT_STAGGER_MILLISECONDS = 50;

/** The end of the landing page: a row of bots peeking up over the footer's edge. */
export function PeekingBots() {
	return (
		// Under the pointer, they all lift together, each a beat after the last.
		<Reveal
			stagger={0.1}
			delay={0.2}
			aria-hidden
			className="group flex items-end justify-center gap-1 overflow-hidden pt-24 sm:gap-1.5 sm:pt-40"
		>
			{peekingBots.map(({ look, place }, index) => (
				<motion.div key={look.color} variants={riseIn} className={cn("shrink-0", place)}>
					<BotFace
						{...look}
						style={{ transitionDelay: `${index * LIFT_STAGGER_MILLISECONDS}ms` }}
						className="size-full transition-transform duration-500 ease-landing group-hover:-translate-y-4"
					/>
				</motion.div>
			))}
		</Reveal>
	);
}
