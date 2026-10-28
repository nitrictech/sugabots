import { X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "@/ui/icon-button.tsx";

/**
 * Something a bot made or is doing, opened large beside its chat or a list so
 * it can be talked about while it is looked at. On a phone it covers them.
 */
export function Stage({
	label,
	icon,
	title,
	byline,
	actions,
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
	onClose: () => void;
	children: ReactNode;
}) {
	return (
		<section
			aria-label={label}
			onKeyDown={(event) => {
				if (event.key === "Escape") onClose();
			}}
			className="flex min-h-0 min-w-0 flex-1 flex-col bg-background max-md:absolute max-md:inset-0 max-md:z-40"
		>
			<header className="flex h-[52px] shrink-0 items-center gap-2 border-border border-b pr-3 pl-4 max-md:pl-3">
				{icon}
				<div className="flex min-w-0 flex-1 flex-col pl-1 leading-snug">
					<h2 className="m-0 truncate font-medium text-[14px] text-foreground">{title}</h2>
					{byline && <p className="m-0 truncate text-subtle-foreground text-xs">{byline}</p>}
				</div>
				{actions}
				<IconButton label="Close" variant="bar" onClick={onClose}>
					<X size={16} strokeWidth={1.75} />
				</IconButton>
			</header>
			<div className="flex min-h-0 flex-1 flex-col px-6 pt-4 pb-6 max-md:px-3 max-md:pb-3">
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
