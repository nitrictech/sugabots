import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Badge } from "@/ui/badge.tsx";

export function Sidebar({ className, ...props }: ComponentProps<"nav">) {
	return (
		<nav
			className={cn("flex min-h-0 w-full flex-col text-sidebar-foreground", className)}
			{...props}
		/>
	);
}

/**
 * A named group of rows that folds.
 *
 * The heading is the disclosure, so the whole of it is the hit target rather
 * than a chevron somebody has to aim at. `actions` sit outside that button —
 * nested buttons are not a thing — and stay drawn whether the section is open
 * or shut, because an action that appears on hover is an action nobody on a
 * touchscreen ever finds.
 *
 * Folded, the section says how much it is hiding; open, the rows say it
 * themselves and the number would be noise.
 */
export function SidebarSection({
	label,
	open,
	onToggle,
	count,
	status,
	actions,
	children,
	className,
}: {
	label: string;
	open: boolean;
	onToggle: () => void;
	/** How many rows are inside. Drawn only while folded. */
	count?: number;
	/** A state shown beside the name, outside the disclosure so it can have its own tooltip. */
	status?: ReactNode;
	/** Controls at the end of the heading, beside the disclosure. */
	actions?: ReactNode;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("pb-4", className)}>
			<h2 className="flex items-center gap-0.5 pt-3 pb-1">
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={open}
					// On screen the count is a gap away from the name, which a name
					// taken from the contents does not hear: "Sales4".
					aria-label={count === undefined || open ? undefined : `${label}, ${count}`}
					className="focus-ring flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 font-semibold text-base text-sidebar-muted-foreground transition-colors hover:bg-sidebar-accent motion-reduce:transition-none"
				>
					<ChevronRight
						aria-hidden
						size={14}
						strokeWidth={2.4}
						className={cn(
							"shrink-0 text-subtle-foreground transition-transform motion-reduce:transition-none",
							open && "rotate-90",
						)}
					/>
					<span className="min-w-0 flex-1 truncate text-left">{label}</span>
					{!open && count !== undefined && (
						<Badge variant="filled" aria-hidden="true">
							{count}
						</Badge>
					)}
				</button>
				{status}
				{actions}
			</h2>
			{open && children}
		</section>
	);
}

/**
 * One row. Renders as whatever it is given — a router `Link`, a `button`, or a
 * plain `div` for something not yet clickable — so that a disabled row and a
 * live one are the same shape rather than two near-identical blocks.
 *
 * Selected is a card, not a wash: white on the ground, with the pane's shadow.
 */
export function SidebarRow({
	as: Component = "div",
	selected = false,
	muted = false,
	className,
	...props
}: {
	as?: React.ElementType;
	/** The row you are looking at. */
	selected?: boolean;
	/** Present but not available, like the personal agents section. */
	muted?: boolean;
	className?: string;
	// biome-ignore lint/suspicious/noExplicitAny: the element decides its own props
	[key: string]: any;
}) {
	return (
		<Component
			className={cn(
				"flex min-h-14 items-center gap-3 rounded-2xl px-3 py-2.5 transition-colors motion-reduce:transition-none",
				muted ? "opacity-45" : "focus-ring",
				selected && "bg-card shadow-[var(--shadow-row)]",
				!selected && !muted && "hover:bg-sidebar-accent",
				className,
			)}
			{...props}
		/>
	);
}
