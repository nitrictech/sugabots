import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "cn";
import type { ReactNode } from "react";

/**
 * A sheet rising from a phone's foot over the dimmed page, with a grabber and
 * `title` at its top: tapping the page above it, or Escape, puts it away.
 * Phones only; a wider screen offers the same choice in place, as a menu or
 * a panel.
 */
export function Sheet({
	open,
	onOpenChange,
	title,
	children,
	className,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-scrim duration-100 data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0" />
				<DialogPrimitive.Popup
					className={cn(
						"fixed inset-x-0 bottom-0 z-50 flex max-h-[80%] flex-col gap-3.5 overflow-y-auto rounded-t-[22px] bg-list px-4 pt-2 pb-[max(34px,env(safe-area-inset-bottom))] text-foreground shadow-dialog outline-none motion-safe:animate-sheet-up",
						className,
					)}
				>
					<span
						aria-hidden
						className="h-[5px] w-9 shrink-0 self-center rounded-full bg-border-strong"
					/>
					<DialogPrimitive.Title className="m-0 px-1 pt-0.5 font-semibold text-[17px]">
						{title}
					</DialogPrimitive.Title>
					{children}
				</DialogPrimitive.Popup>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

/** A choice in a sheet: a row as tall as a fingertip, its mark, then its name. */
export const SHEET_ROW_CLASS_NAME =
	"focus-ring flex min-h-[52px] w-full items-center gap-3 rounded-[10px] px-1 text-left text-[16px] text-foreground active:bg-row-hover";
