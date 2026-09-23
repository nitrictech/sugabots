import { cn } from "cn";
import type { ComponentProps, ReactNode } from "react";

type SurfaceDensity = "comfortable" | "compact";

const padding: Record<SurfaceDensity, string> = {
	comfortable: "gap-3 px-4 py-5 md:px-7",
	compact: "gap-2.5 px-4 py-3.5",
};

export function SurfaceHeader({
	density = "comfortable",
	className,
	...props
}: ComponentProps<"header"> & { density?: SurfaceDensity }) {
	return (
		<header
			className={cn(
				"relative flex min-h-header shrink-0 items-center border-b border-border-subtle",
				padding[density],
				className,
			)}
			{...props}
		/>
	);
}

export function SurfaceGlow({ hue }: { hue: number }) {
	return (
		<span
			aria-hidden
			className="agent-tint pointer-events-none absolute inset-x-[-90px] top-[-90px] h-[340px] blur-[52px]"
			style={{
				["--agent-hue" as string]: hue,
				background: "radial-gradient(58% 74% at 78% 6%, var(--agent-fill) 0%, transparent 78%)",
				opacity: 0.62,
			}}
		/>
	);
}

export function SurfaceTitle({
	title,
	subtitle,
	color,
	size = "lg",
	align = "center",
}: {
	title: ReactNode;
	subtitle?: ReactNode;
	/** An agent's name takes the agent's colour; anything else takes the heading colour. */
	color?: string;
	/** `lg` for a pane, `sm` for the narrower panel and for dialogs. */
	size?: "lg" | "sm";
	/** `start` when the title can wrap to two lines, as a thread's does. */
	align?: "center" | "start";
}) {
	return (
		<div className={cn("min-w-0 flex-1", align === "start" && "self-start")}>
			<div
				className={cn(
					"font-semibold",
					size === "lg" ? "truncate text-2xl text-heading" : "text-lg text-heading",
				)}
				style={color ? { color } : undefined}
			>
				{title}
			</div>
			{subtitle !== undefined && (
				<div
					className={cn(
						"truncate",
						size === "lg"
							? "pt-1 text-base text-surface-muted-foreground"
							: "pt-0.5 font-mono text-subtle-foreground text-xs",
					)}
				>
					{subtitle}
				</div>
			)}
		</div>
	);
}

export function SurfaceColumn({ className, ...props }: ComponentProps<"div">) {
	return <div className={cn("mx-auto w-full max-w-home", className)} {...props} />;
}
