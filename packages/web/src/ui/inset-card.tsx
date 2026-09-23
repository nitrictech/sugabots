import { cn } from "cn";
import type { ComponentProps, ReactNode } from "react";

export function InsetCard({ className, ...props }: ComponentProps<"section">) {
	return (
		<section
			className={cn("rounded-[14px] border border-border-subtle bg-sunken", className)}
			{...props}
		/>
	);
}

export function InsetCardHeading({
	icon,
	children,
	className,
}: {
	icon?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<h3
			className={cn(
				"flex items-center gap-2 font-semibold text-2xs text-subtle-foreground uppercase tracking-[0.06em]",
				className,
			)}
		>
			{icon}
			{children}
		</h3>
	);
}
