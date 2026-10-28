import { cn } from "cn";
import { ChevronLeft, X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "@/ui/icon-button.tsx";

/**
 * Something a bot made or is doing, opened large beside its chat or a list so
 * it can be talked about while it is looked at. On a phone it covers them,
 * with Back at the left of its title, centred; or, `immersive`, edge to edge
 * on black under a frosted Close, for a screen to watch.
 */
export function Stage({
	label,
	icon,
	title,
	byline,
	actions,
	immersive = false,
	onClose,
	children,
}: {
	/** Its name, as assistive technology announces it. */
	label: string;
	/** A `StageMark`, or another mark of what is shown. */
	icon: ReactNode;
	title: string;
	/** A quieter line under the title, such as who made it and when. */
	byline?: ReactNode;
	/** Controls for what is shown, before Close. */
	actions?: ReactNode;
	immersive?: boolean;
	onClose: () => void;
	children: ReactNode;
}) {
	return (
		<section
			aria-label={label}
			onKeyDown={(event) => {
				if (event.key === "Escape") onClose();
			}}
			className={cn(
				"flex min-h-0 min-w-0 flex-1 flex-col bg-background max-md:absolute max-md:inset-0 max-md:z-40",
				immersive && "max-md:bg-black",
			)}
		>
			<header
				className={cn(
					"flex h-[52px] shrink-0 items-center gap-2 border-border border-b pr-3 pl-4",
					immersive
						? "max-md:hidden"
						: "max-md:h-auto max-md:gap-1 max-md:px-1.5 max-md:pt-[calc(env(safe-area-inset-top)+8px)] max-md:pb-1.5",
				)}
			>
				<IconButton label="Back" onClick={onClose} className="size-11 md:hidden">
					<ChevronLeft size={22} strokeWidth={2} />
				</IconButton>
				<span className="contents max-md:hidden">{icon}</span>
				<div className="flex min-w-0 flex-1 flex-col pl-1 leading-snug max-md:items-center max-md:pl-0">
					<h2 className="m-0 max-w-full truncate font-medium text-[14px] text-foreground max-md:font-semibold max-md:text-[15px]">
						{title}
					</h2>
					{byline && (
						<p className="m-0 max-w-full truncate text-subtle-foreground text-xs">{byline}</p>
					)}
				</div>
				{actions}
				{!actions && <span aria-hidden className="w-11 shrink-0 md:hidden" />}
				<IconButton label="Close" variant="bar" onClick={onClose} className="max-md:hidden">
					<X size={16} strokeWidth={1.75} />
				</IconButton>
			</header>
			{immersive && (
				<IconButton
					label="Close"
					variant="glass"
					onClick={onClose}
					className="absolute top-[calc(env(safe-area-inset-top)+12px)] left-4 z-10 md:hidden"
				>
					<X aria-hidden size={18} strokeWidth={2} />
				</IconButton>
			)}
			<div
				className={cn(
					"flex min-h-0 flex-1 flex-col px-6 pt-4 pb-6",
					immersive ? "max-md:p-0" : "max-md:px-3 max-md:pb-3",
				)}
			>
				{children}
			</div>
		</section>
	);
}

/**
 * The square that marks what kind of thing a `Stage` or a card shows.
 */
export function StageMark({ children }: { children: ReactNode }) {
	return (
		<span
			aria-hidden
			className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-chip text-muted-foreground [&_svg]:size-[15px]"
		>
			{children}
		</span>
	);
}
