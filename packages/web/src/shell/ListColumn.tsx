import { cn } from "cn";
import type { ReactNode } from "react";
import { formatListTime } from "@/lib/list-time.ts";

/**
 * The column beside the rail that lists what a view holds, such as a pod's
 * chats, Activity or Approvals: its title across the top, with `actions` at
 * the right, and the list under it.
 */
export function ListColumn({
	title,
	actions,
	className,
	children,
}: {
	title: string;
	actions?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<section
			aria-label={title}
			className={cn(
				"flex min-h-0 min-w-0 flex-1 flex-col border-border border-r bg-list md:w-[280px] md:flex-none lg:w-80",
				className,
			)}
		>
			<header className="flex h-14 shrink-0 items-center gap-1.5 border-border border-b pr-2.5 pl-2">
				<h1 className="m-0 min-w-0 flex-1 truncate px-2.5 font-bold text-[17px] text-foreground tracking-[-0.01em]">
					{title}
				</h1>
				{actions}
			</header>
			{children}
		</section>
	);
}

/**
 * The faint grey of a row's quieter words, such as its time. A step lighter on
 * the chosen row, whose wash would take the faint grey below AA.
 */
export function quietRowText(selected: boolean): string {
	return selected ? "text-muted-foreground" : "text-subtle-foreground";
}

/** When a row's item happened, at its right. */
export function ListTime({ at, selected }: { at: string; selected: boolean }) {
	return (
		<time dateTime={at} className={cn("shrink-0 text-xs", quietRowText(selected))}>
			{formatListTime(new Date(at), new Date())}
		</time>
	);
}
