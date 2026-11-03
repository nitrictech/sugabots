import { cn } from "cn";
import { ChevronLeft, X } from "lucide-react";
import type { ReactNode } from "react";
import { BACK_BUTTON, BackChevron, useLeave } from "@/ui/back-button.tsx";
import { FLOATING_ON_PHONE, IconButton } from "@/ui/icon-button.tsx";

/**
 * Closes a `Stage`, showing what was open under it. `replace` asks for that in
 * the stage's place in history, rather than as a page after it, for a phone's
 * Back from a stage that was the first page opened.
 */
export type CloseStage = (how?: { replace: boolean }) => void;

/**
 * The level a view inside a stage was opened from, such as a bot's routines
 * above one of them, which its Back returns to.
 */
export interface StageParent {
	/** Where Back goes, as a screen reader hears it: "Back to" this. */
	name: string;
	onBack: () => void;
}

/**
 * Back to `parent`, before the title of a view inside a stage, on any screen,
 * so going into the view and back out reads as moving down and up a level.
 */
export function StageBack({ parent }: { parent: StageParent }) {
	return (
		<IconButton
			label={`Back to ${parent.name}`}
			variant="bar"
			onClick={parent.onBack}
			className={cn("-ml-1.5 text-muted-foreground hover:text-foreground", FLOATING_ON_PHONE)}
		>
			<ChevronLeft size={18} strokeWidth={2} />
		</IconButton>
	);
}

/**
 * Something a bot made or is doing, opened large beside its chat or a list so
 * it can be talked about while it is looked at. On a phone it covers them.
 * With `parent`, it is a view inside another, and its Back, before the
 * title, returns there.
 */
export function Stage({
	label,
	icon,
	title,
	byline,
	actions,
	parent,
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
	/** The view this one was opened from, when it is one level inside another. */
	parent?: StageParent;
	onClose: CloseStage;
	children: ReactNode;
}) {
	const { leave } = useLeave();
	return (
		<section
			aria-label={label}
			onKeyDown={(event) => {
				if (event.key === "Escape") onClose();
			}}
			className="flex min-h-0 min-w-0 flex-1 flex-col bg-background max-md:absolute max-md:inset-0 max-md:z-40"
		>
			<header className="flex h-[52px] shrink-0 items-center gap-2 border-border border-b pr-3 pl-4 max-md:h-auto max-md:border-b-0 max-md:px-4 max-md:pt-[max(12px,env(safe-area-inset-top))] max-md:pb-2">
				{parent && <StageBack parent={parent} />}
				{/* On a phone it covers the page it was opened from, so it goes back to it, as a phone's pages do. */}
				{!parent && (
					<button
						type="button"
						aria-label="Back"
						onClick={() => {
							// Opened first, it is replaced, so Back from what shows does not return to it.
							leave(() => onClose({ replace: true }));
						}}
						className={cn(BACK_BUTTON, "md:hidden")}
					>
						<BackChevron />
					</button>
				)}
				{!parent && <span className="contents max-md:hidden">{icon}</span>}
				<div className="flex min-w-0 flex-1 flex-col pl-1 leading-snug">
					<h2 className="m-0 truncate font-medium text-[14px] text-foreground max-md:font-semibold max-md:text-[17px]">
						{title}
					</h2>
					{byline && <p className="m-0 truncate text-subtle-foreground text-xs">{byline}</p>}
				</div>
				{actions}
				<IconButton label="Close" variant="bar" onClick={() => onClose()} className="max-md:hidden">
					<X size={16} strokeWidth={1.75} />
				</IconButton>
			</header>
			<div className="flex min-h-0 flex-1 flex-col px-6 pt-4 pb-6 max-md:px-3 max-md:pb-[calc(var(--tab-bar-space,0px)+0.75rem)]">
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
