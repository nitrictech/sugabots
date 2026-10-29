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

/** The end of the landing page: a row of bots peeking up over the footer's edge. */
export function PeekingBots() {
	return (
		<Reveal
			stagger={0.1}
			delay={0.2}
			aria-hidden
			className="flex items-end justify-center gap-1 overflow-hidden pt-24 sm:gap-1.5 sm:pt-40"
		>
			{peekingBots.map(({ look, place }) => (
				// Each lifts while the pointer is on its head, not the box around it.
				<motion.div
					key={look.color}
					variants={riseIn}
					className={cn("group pointer-events-none relative shrink-0", place)}
				>
					<BotFace
						{...look}
						className="size-full transition-transform duration-500 ease-landing group-hover:-translate-y-4"
					/>
					{/*
					 * An unseen copy of the head that takes the pointer where it's painted. It
					 * stays put as the head lifts, so the head doesn't slip out from under the pointer.
					 */}
					<BotFace
						{...look}
						className="absolute inset-0 size-full opacity-0 [&_*]:pointer-events-auto"
					/>
				</motion.div>
			))}
		</Reveal>
	);
}
