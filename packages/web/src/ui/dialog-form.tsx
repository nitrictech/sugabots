import { cn } from "cn";
import type { FormEvent, ReactNode } from "react";
import { DialogContent } from "@/ui/dialog.tsx";

const widths = {
	compact: "max-w-[480px] sm:max-w-[480px]",
	default: "max-w-[520px] sm:max-w-[520px]",
} as const;

/** DialogForm renders a modal form inside Dialog. Supply a DialogTitle and labelled fields. */
export function DialogForm({
	width = "default",
	onSubmit,
	children,
}: {
	width?: keyof typeof widths;
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
	children: ReactNode;
}) {
	return (
		<DialogContent
			showCloseButton={false}
			className={cn("gap-0 overflow-hidden rounded-2xl p-0", widths[width])}
		>
			{/*
			 * `min-w-0`: the popup is a grid, and a grid item is otherwise at least
			 * as wide as its content's narrowest line. A header subtitle that does
			 * not wrap would then widen the form past the dialog, which clips it,
			 * and the right edge of every row would be cut off.
			 */}
			<form onSubmit={onSubmit} className="flex min-w-0 flex-col">
				{children}
			</form>
		</DialogContent>
	);
}

export function DialogFormBody({
	gap = "default",
	children,
}: {
	gap?: "compact" | "default";
	children: ReactNode;
}) {
	return (
		<div className={cn("flex flex-col px-6 py-5", gap === "compact" ? "gap-3" : "gap-5")}>
			{children}
		</div>
	);
}

export function DialogFormFooter({ children }: { children: ReactNode }) {
	return (
		<footer className="flex items-center justify-end gap-2 border-border-subtle border-t bg-muted px-6 py-2.5">
			{children}
		</footer>
	);
}
