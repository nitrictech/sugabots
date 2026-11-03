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
			<h2 className="text-3xl lg:text-4xl/none font-bold tracking-tight text-balance">{title}</h2>
			<p className="text-base/normal text-pretty text-landing-muted">{lede}</p>
		</div>
	);
}
