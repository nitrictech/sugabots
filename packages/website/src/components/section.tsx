import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { type AccentTone, accentText } from "@/components/accent";
import { Reveal, riseIn } from "@/components/reveal";

const section = cva("border-t py-16", {
	variants: {
		layout: {
			/** Heading above the content. */
			stacked: "flex flex-col gap-6",
			/** Heading beside the content from medium screens up. */
			split: "grid items-center gap-12 md:grid-cols-2",
		},
	},
	defaultVariants: { layout: "stacked" },
});

interface SectionProps extends VariantProps<typeof section> {
	eyebrow: string;
	tone: AccentTone;
	title: string;
	/** A sentence or two; may use `Emphasis`. */
	description: ReactNode;
	children: ReactNode;
}

/** A landing-page section: a coloured eyebrow, a heading, a lede, then content. */
export function Section({
	eyebrow: label,
	tone,
	title,
	description,
	layout,
	children,
}: SectionProps) {
	return (
		<section className={section({ layout })}>
			<header>
				<Reveal className="flex flex-col gap-6">
					<motion.p
						variants={riseIn}
						className={cn("flex items-center gap-2 text-sm font-semibold", accentText({ tone }))}
					>
						<span className="size-2 rounded-full bg-current" />
						{label}
					</motion.p>
					<motion.h2
						variants={riseIn}
						className={cn("text-4xl font-extrabold leading-tight tracking-tight text-balance")}
					>
						{title}
					</motion.h2>
					<motion.p variants={riseIn} className="max-w-2xl text-muted-foreground text-pretty">
						{description}
					</motion.p>
				</Reveal>
			</header>
			{children}
		</section>
	);
}
