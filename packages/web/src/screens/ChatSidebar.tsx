import { cn } from "cn";
import { X } from "lucide-react";
import { type ReactNode, type Ref, useState } from "react";
import { IconButton } from "@/ui/icon-button.tsx";

/**
 * The column beside a chat: Details, or a collaboration or routine run opened
 * from its line. Only a wide screen has room for both side by side; on a
 * tablet it slides over the dimmed chat from the right, and on a phone it
 * covers the chat or, as a `sheet`, rises from the bottom over it.
 */
export function ChatSidebar({
	label,
	heading = label,
	subheading,
	headingRef,
	onClose,
	sheet = false,
	actions,
	className,
	children,
}: {
	/** Its name, as assistive technology announces it. */
	label: string;
	/** What its header says, when that is not its name. */
	heading?: string;
	/** A quieter line beside the heading, such as who is in it. */
	subheading?: string;
	/** For focusing the heading when the sidebar opens, so a screen reader starts there. */
	headingRef?: Ref<HTMLHeadingElement>;
	onClose: () => void;
	sheet?: boolean;
	/** Buttons for what the sidebar shows, beside its Close; each an `IconButton` with `variant="bar"`. */
	actions?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<>
			{/* The dimmed chat behind it closes it, as a tap outside a sheet or drawer does. */}
			<button
				type="button"
				tabIndex={-1}
				aria-hidden
				onClick={onClose}
				className={cn(
					"absolute inset-0 z-30 cursor-default bg-scrim xl:hidden",
					!sheet && "max-md:hidden",
				)}
			/>
			<aside
				aria-label={label}
				onKeyDown={(event) => {
					if (event.key === "Escape") onClose();
				}}
				className={cn(
					"flex min-h-0 w-[380px] shrink-0 flex-col border-border border-l bg-aside max-md:absolute max-md:z-40 max-md:w-full max-md:border-l-0",
					"md:max-xl:absolute md:max-xl:inset-y-0 md:max-xl:right-0 md:max-xl:z-40 md:max-xl:w-[min(400px,100%)] md:max-xl:border-l-0 md:max-xl:shadow-dialog",
					sheet
						? "max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[82%] max-md:rounded-t-dialog max-md:shadow-dialog max-md:motion-safe:animate-sheet-up max-md:bg-list"
						: "max-md:inset-0",
					className,
				)}
			>
				{sheet && (
					<span
						aria-hidden
						className="mx-auto mt-2 mb-3.5 h-1 w-9 shrink-0 rounded-full bg-border-strong md:hidden"
					/>
				)}
				<header className="flex h-14 shrink-0 items-center gap-2 border-border border-b pr-3 pl-[18px]">
					<div className="flex min-w-0 flex-1 items-baseline gap-2">
						<h2
							ref={headingRef}
							tabIndex={headingRef ? -1 : undefined}
							className="m-0 min-w-0 shrink-0 truncate font-semibold text-[15px] text-foreground outline-none max-md:shrink"
						>
							{heading}
						</h2>
						{subheading && (
							<span className="min-w-0 truncate text-[13px] text-subtle-foreground">
								{subheading}
							</span>
						)}
					</div>
					{actions}
					{/* A sheet closes by its dimmed backdrop on a phone; Close stays for the keyboard. */}
					<IconButton
						label="Close"
						variant="bar"
						onClick={onClose}
						className={cn(sheet && "max-md:not-focus-visible:sr-only")}
					>
						<X size={16} strokeWidth={2.2} />
					</IconButton>
				</header>
				{children}
			</aside>
		</>
	);
}

/**
 * A labelled group in a sidebar: its name, with a note at the right such as
 * when it was updated, then its rows on a card, or loose with `card={false}`.
 */
export function SidebarSection({
	title,
	note,
	card = true,
	children,
	className,
}: {
	title: string;
	note?: ReactNode;
	card?: boolean;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section>
			<div className="flex items-baseline gap-2 px-0.5 pb-2">
				<h3 className="m-0 flex-1 font-medium text-muted-foreground text-sm">{title}</h3>
				{note && <span className="text-subtle-foreground text-xs">{note}</span>}
			</div>
			<div
				className={cn(card && "overflow-hidden rounded-xl border border-border bg-list", className)}
			>
				{children}
			</div>
		</section>
	);
}

/** The first `shown` of a list, as list items, and a Show more row for the rest. */
export function Expandable<Item>({
	items,
	shown,
	children,
}: {
	items: readonly Item[];
	shown: number;
	children: (item: Item) => ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const visible = open ? items : items.slice(0, shown);
	return (
		<>
			<ul className="m-0 list-none p-0">{visible.map(children)}</ul>
			{items.length > shown && <ShowMore open={open} onToggle={() => setOpen(!open)} />}
		</>
	);
}

export function ShowMore({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			aria-expanded={open}
			onClick={onToggle}
			className="focus-ring block w-full border-border border-t px-3.5 py-[9px] text-left font-medium text-[13px] text-link"
		>
			{open ? "Show less" : "Show more"}
		</button>
	);
}
