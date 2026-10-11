import type { ReactNode } from "react";
import { CloseButton } from "@/ui/close-button.tsx";

/**
 * Something a bot made or is doing, opened large beside its chat so it can be
 * talked about while it is looked at. It takes the room the conversation list
 * had; on a phone it covers the chat.
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
			className="flex min-h-0 min-w-0 flex-1 flex-col bg-stage max-md:absolute max-md:inset-0 max-md:z-40"
		>
			<header className="flex h-16 shrink-0 items-center gap-2.5 px-4 max-md:px-3">
				{icon}
				<div className="flex min-w-0 flex-1 flex-col gap-px">
					<h2 className="m-0 truncate font-semibold text-[15px] text-foreground">{title}</h2>
					{byline && <p className="m-0 truncate text-[12.5px] text-muted-foreground">{byline}</p>}
				</div>
				{actions}
				<CloseButton onClick={onClose} />
			</header>
			<div className="flex min-h-0 flex-1 flex-col px-6 pb-6 max-md:px-3 max-md:pb-3">
				{children}
			</div>
		</section>
	);
}

/**
 * The square that marks what kind of thing a `Stage` or a card shows, in the
 * colours of the bot it belongs to where one is set around it.
 */
export function StageMark({ children }: { children: ReactNode }) {
	return (
		<span
			aria-hidden
			className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-(--bot-tint,var(--chip)) text-(--bot-text,var(--soft-foreground)) [&_svg]:size-4"
		>
			{children}
		</span>
	);
}
