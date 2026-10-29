import { cn } from "cn";

interface SectionHeadingProps {
	title: string;
	lede: string;
	className?: string;
}

/** A section's heading and the sentence under it, centred over the section. */
export function SectionHeading({ title, lede, className }: SectionHeadingProps) {
	return (
		<div className={cn("flex max-w-160 flex-col gap-3 self-center text-center", className)}>
			<h2 className="text-[clamp(28px,3.4vw,40px)]/[1.1] font-bold tracking-[-0.025em] text-balance">
				{title}
			</h2>
			<p className="text-[17px]/[1.55] text-pretty text-landing-muted">{lede}</p>
		</div>
	);
}
