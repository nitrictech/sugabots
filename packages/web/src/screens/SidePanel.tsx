import { cn } from "cn";
import { ChevronDown } from "lucide-react";
import { createContext, type ReactNode, use, useState } from "react";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { usePanelKeys } from "@/lib/panel-keys.ts";
import { BackButton } from "@/ui/back-button.tsx";
import { Button } from "@/ui/button.tsx";
import { CloseButton } from "@/ui/close-button.tsx";

/**
 * The column beside a chat: its Details, or an automation's panel. Only a
 * wide screen has room for both side by side; on a tablet it slides over the
 * dimmed chat from the right, and on a phone it covers the chat.
 *
 * `floating` Details are instead a stack of cards over the chat's right edge,
 * each folding to its title, with the chat showing between them; a phone
 * still covers the chat with them.
 */
export function SidePanel({
	label,
	onClose,
	headerless = false,
	floating = false,
	actions,
	className,
	children,
}: {
	/** Its name, as its header says and assistive technology announces it. */
	label: string;
	onClose: () => void;
	/**
	 * Without its header where it sits beside the chat, as Details does: what it
	 * shows heads it, and the chat's own button closes it. Where it covers the
	 * chat, the header stays for its Close.
	 */
	headerless?: boolean;
	/** Cards floating beside the chat rather than a column, from a tablet up. */
	floating?: boolean;
	/** Buttons for what the side panel shows, beside its Close; each an `IconButton` with `variant="bar"`. */
	actions?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	const keys = usePanelKeys<HTMLElement>(onClose);
	return (
		<>
			{/* The dimmed chat behind it closes it, as a tap outside a drawer does. */}
			<button
				type="button"
				tabIndex={-1}
				aria-hidden
				onClick={onClose}
				className={cn(
					"absolute inset-0 z-30 cursor-default bg-scrim max-md:hidden xl:hidden",
					floating && "hidden",
				)}
			/>
			<aside
				aria-label={label}
				{...keys}
				className={cn(
					"flex min-h-0 w-95 outline-none shrink-0 flex-col border-border border-l bg-aside max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full max-md:border-l-0",
					floating
						? // Under the header's Details button, over the chat, which makes way for it; the chat stays reachable between the cards.
							"md:pointer-events-none md:absolute md:top-13 md:right-0 md:bottom-0 md:z-20 md:w-68 md:border-l-0 md:bg-transparent md:motion-safe:animate-cards-in"
						: "md:max-xl:absolute md:max-xl:inset-y-0 md:max-xl:right-0 md:max-xl:z-40 md:max-xl:w-100 max-w-full md:max-xl:border-l-0 md:max-xl:shadow-dialog",
					className,
				)}
			>
				<header
					className={cn(
						"flex h-13 shrink-0 items-center gap-2 border-border border-b pr-3 pl-4.5",
						headerless && (floating ? "md:hidden" : "xl:hidden"),
						// On a phone, what it shows heads it, so its header is only the round Back.
						headerless &&
							"max-md:h-auto max-md:border-b-0 max-md:px-4 max-md:pt-safe-or-3 max-md:pb-2",
					)}
				>
					{headerless && <BackButton onClick={onClose} className="md:hidden" />}
					<h2
						className={cn(
							"m-0 min-w-0 flex-1 truncate font-semibold text-sm text-foreground",
							headerless && "max-md:sr-only",
						)}
					>
						{label}
					</h2>
					{actions}
					<CloseButton onClick={onClose} className={headerless ? "max-md:hidden" : undefined} />
				</header>
				<FloatingCards value={floating}>{children}</FloatingCards>
			</aside>
		</>
	);
}

/** Whether the sections inside are floating cards, which `SidePanel` says for its `floating` Details. */
const FloatingCards = createContext(false);

/** One floating Details card's surface. */
const FLOATING_CARD =
	"md:pointer-events-auto md:rounded-xl md:border md:border-glass-edge md:bg-glass md:shadow-popover md:backdrop-blur-xl";

/**
 * A labelled group in a side panel, ruled off from the one above: its name, with
 * `end` at the right, such as a figure, then what it holds. On a phone, its
 * name over a card of what it holds, as a phone's own settings group them.
 * Among floating Details it is a card of its own, whose name folds it.
 */
export function PanelSection({
	title,
	end,
	children,
}: {
	title: string;
	end?: ReactNode;
	children?: ReactNode;
}) {
	const inFloatingCards = use(FloatingCards);
	const sideBySide = useMediaQuery(SIDE_BY_SIDE);
	const floating = inFloatingCards && sideBySide;
	const [folded, setFolded] = useState(false);
	if (floating) {
		return (
			<section className={cn("flex flex-col gap-2 px-3.5 py-3", FLOATING_CARD)}>
				<div className="flex items-center gap-2">
					<h3 className="m-0 flex-1">
						<button
							type="button"
							aria-expanded={!folded}
							onClick={() => setFolded(!folded)}
							className="focus-ring flex w-full items-center gap-2 rounded-sm text-left font-semibold text-foreground text-xs"
						>
							<span className="flex-1">{title}</span>
							<ChevronDown
								aria-hidden
								size={14}
								strokeWidth={2}
								className={cn(
									"text-subtle-foreground transition-transform",
									folded && "-rotate-90",
								)}
							/>
						</button>
					</h3>
					{!folded && end}
				</div>
				{children && !folded && (
					<div className="flex flex-col gap-1.5 empty:hidden">{children}</div>
				)}
			</section>
		);
	}
	return (
		<section className="flex flex-col gap-2.5 border-border border-t px-5 py-4 max-md:gap-2 max-md:border-t-0 max-md:px-4 max-md:py-2.5">
			<div className="flex items-center gap-2 max-md:px-1">
				<h3 className="m-0 flex-1 font-medium text-subtle-foreground text-xs">{title}</h3>
				{end}
			</div>
			{children && (
				<div className="flex flex-col gap-2.5 max-md:rounded-xl max-md:border max-md:border-border max-md:bg-card max-md:px-4 max-md:py-2 max-md:empty:hidden">
					{children}
				</div>
			)}
		</section>
	);
}

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
			<ul className="m-0 flex list-none flex-col p-0">{visible.map(children)}</ul>
			{items.length > shown && <ShowMore open={open} onToggle={() => setOpen(!open)} />}
		</>
	);
}

/** A small text button under something folded, opening the rest of it or folding it again. */
export function ShowMore({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	return (
		<Button
			variant="quiet"
			size="text"
			aria-expanded={open}
			onClick={onToggle}
			className="self-start rounded-sm"
		>
			{open ? "Show less" : "Show more"}
		</Button>
	);
}
