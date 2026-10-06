import { cn } from "cn";
import { X } from "lucide-react";
import { type ReactNode, useState } from "react";

/**
 * The column beside a chat: Details, or a collaboration or routine run opened
 * from its line. Only a wide screen has room for both side by side; on a
 * tablet it slides over the dimmed chat from the right, and on a phone it
 * covers the chat or, as a `sheet`, rises from the bottom over it.
 */
/** A round button in the bar at the top of a sidebar, such as its Close. */
export const sidebarBarButton =
	"focus-ring grid size-8 place-items-center rounded-full bg-chip text-soft-foreground transition-colors hover:bg-hover";

export function ChatSidebar({
	label,
	onClose,
	sheet = false,
	closedFromHeader = false,
	actions,
	className,
	children,
}: {
	label: string;
	onClose: () => void;
	sheet?: boolean;
	/**
	 * Whether the chat's header has the button that closes it, so it needs no
	 * Close of its own except on a phone, where it covers the header too.
	 */
	closedFromHeader?: boolean;
	/** Buttons for what the sidebar shows, beside its Close; each styled with `sidebarBarButton`. */
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
					"flex min-h-0 w-[360px] shrink-0 flex-col border-border border-l max-md:absolute max-md:z-40 max-md:w-full max-md:border-l-0",
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
				{/* A sheet closes by its dimmed backdrop on a phone; Close stays for the keyboard. */}
				<div
					className={cn(
						"flex shrink-0 items-center justify-end gap-1.5 px-3.5 pt-3.5",
						sheet && "max-md:absolute max-md:top-2 max-md:right-2 max-md:p-0",
						closedFromHeader && "md:hidden",
					)}
				>
					{actions}
					<button
						type="button"
						aria-label="Close"
						onClick={onClose}
						className={cn(sidebarBarButton, sheet && "max-md:not-focus-visible:sr-only")}
					>
						<X size={15} strokeWidth={2.4} />
					</button>
				</div>
				{children}
			</aside>
		</>
	);
}

/** A labelled group in a sidebar: its name, then its rows on a raised card. */
export function SidebarSection({
	title,
	children,
	className,
}: {
	title: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section>
			<h3 className="m-0 px-1 pb-2 font-medium text-sm text-subtle-foreground">{title}</h3>
			<div className={cn("overflow-hidden rounded-panel bg-panel", className)}>{children}</div>
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
			className="focus-ring block w-full border-border-subtle border-t px-3.5 py-2.5 text-left font-medium text-[13px] text-link"
		>
			{open ? "Show less" : "Show more"}
		</button>
	);
}
