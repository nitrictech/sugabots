import { motion, type Variants } from "motion/react";
import type { ComponentProps } from "react";
import { Card } from "@/components/ui/card";

/** A short rise and fade: how text, cards and messages arrive. */
export const riseIn: Variants = {
	hidden: { opacity: 0, y: 12 },
	visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } },
};

/** A springy pop from slightly small: how a bot's face arrives. */
export const popIn: Variants = {
	hidden: { opacity: 0, scale: 0.6 },
	visible: { opacity: 1, scale: 1, transition: { type: "spring", stiffness: 320, damping: 18 } },
};

interface RevealProps extends ComponentProps<typeof motion.div> {
	/** Seconds between one child starting and the next. */
	stagger?: number;
	/** Seconds before the first child starts. */
	delay?: number;
}

/**
 * Plays its animated children in order, once, when it scrolls into view.
 * Children opt in with the `riseIn` or `popIn` variants, usually via `RevealItem`.
 */
export function Reveal({ stagger = 0.08, delay = 0, ...props }: RevealProps) {
	return (
		<motion.div
			initial="hidden"
			whileInView="visible"
			viewport={{ once: true, amount: 0.3 }}
			variants={{
				hidden: {},
				visible: { transition: { staggerChildren: stagger, delayChildren: delay } },
			}}
			{...props}
		/>
	);
}

const revealItemVariants = { rise: riseIn, pop: popIn } as const;

interface RevealItemProps extends ComponentProps<typeof motion.div> {
	/** `pop` for a bot's face; `rise` for everything else. */
	variant?: keyof typeof revealItemVariants;
}

/** One step of a `Reveal`: arrives when its turn comes. */
export function RevealItem({ variant = "rise", ...props }: RevealItemProps) {
	return <motion.div variants={revealItemVariants[variant]} {...props} />;
}

/** A shadcn `Card` that can take part in a `Reveal`, e.g. with `variants={riseIn}`. */
export const MotionCard = motion.create(Card);
