import { cn } from "cn";
import { ChevronLeft } from "lucide-react";
import { type ReactNode, type Ref, useState } from "react";
import { CloseButton } from "@/ui/close-button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";

/**
 * The column beside a chat: Details, or a collaboration or routine run opened
 * from its line. Only a wide screen has room for both side by side; on a
 * tablet it slides over the dimmed chat from the right, and on a phone it
 * covers the chat or, as a `sheet`, rises from the bottom over it. Covering a
 * phone's chat without its header, it is a page with a frosted Back.
 */
export function ChatSidebar({
	label,
	heading = label,
	subheading,
	headingRef,
	onClose,
	sheet = false,
	headerless = false,
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
	/**
	 * Without its header where it sits beside the chat, as Details does: what it
	 * shows heads it, and the chat's own button closes it. Over a tablet's chat,
	 * the header stays for its Close; over a phone's, a Back closes it.
	 */
	headerless?: boolean;
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
					headerless && !sheet && "max-md:bg-background",
					className,
				)}
			>
				{sheet && (
					<span
						aria-hidden
						className="mx-auto mt-2 mb-3.5 h-1 w-9 shrink-0 rounded-full bg-border-strong md:hidden"
					/>
				)}
				<header
					className={cn(
						"flex h-[52px] shrink-0 items-center gap-2 border-border border-b pr-3 pl-[18px]",
						headerless && "xl:hidden",
						headerless && !sheet && "max-md:hidden",
					)}
				>
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
					<CloseButton
						onClick={onClose}
						className={cn(sheet && "max-md:not-focus-visible:sr-only")}
					/>
				</header>
				{headerless && !sheet && (
					<IconButton
						label="Back"
						variant="glass"
						onClick={onClose}
						className="absolute top-[calc(env(safe-area-inset-top)+12px)] left-4 z-10 md:hidden"
					>
						<ChevronLeft aria-hidden size={18} strokeWidth={2.25} />
					</IconButton>
				)}
				{children}
			</aside>
		</>
	);
}

/**
 * A labelled group in a sidebar, ruled off from the one above: its name, with
 * `end` at the right, such as a figure, then what it holds. On a phone what
 * it holds sits on a card under its name, unless it is `bare`.
 */
export function SidebarSection({
	title,
	end,
	bare = false,
	children,
	className,
}: {
	title: string;
	end?: ReactNode;
	bare?: boolean;
	children?: ReactNode;
	className?: string;
}) {
	return (
		<section
			className={cn(
				"flex flex-col gap-2.5 border-border border-t px-5 py-4 max-md:gap-2 max-md:border-t-0 max-md:p-0",
				className,
			)}
		>
			<div className="flex items-center gap-2 max-md:px-1">
				<h3 className="m-0 flex-1 font-medium text-subtle-foreground text-xs max-md:text-[13px]">
					{title}
				</h3>
				{end}
			</div>
			{children &&
				(bare ? (
					children
				) : (
					<div className="flex flex-col gap-2.5 max-md:rounded-[14px] max-md:border max-md:border-border max-md:bg-list max-md:px-3.5 max-md:py-1.5 md:contents">
						{children}
					</div>
				))}
		</section>
	);
}

/** A list in a sidebar section, its rows ruled apart on a phone's card. */
export const SECTION_LIST_CLASS_NAME =
	"m-0 flex list-none flex-col p-0 max-md:divide-y max-md:divide-border";

/** The first `shown` of a list, as list items, and a Show more for the rest. */
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
			<ul className={SECTION_LIST_CLASS_NAME}>{visible.map(children)}</ul>
			{items.length > shown && <ShowMore open={open} onToggle={() => setOpen(!open)} />}
		</>
	);
}

/** A small text button under something folded, opening the rest of it or folding it again. */
export function ShowMore({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			aria-expanded={open}
			onClick={onToggle}
			className="focus-ring self-start rounded-sm text-muted-foreground text-xs hover:text-foreground"
		>
			{open ? "Show less" : "Show more"}
		</button>
	);
}
