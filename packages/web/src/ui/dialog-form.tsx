import { cn } from "cn";
import { ChevronLeft } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { DialogClose, DialogContent, DialogTitle } from "@/ui/dialog.tsx";

const widths = {
	compact: "max-w-[420px] sm:max-w-[420px]",
	default: "max-w-[460px] sm:max-w-[460px]",
} as const;

/** DialogForm renders a modal form inside Dialog. Start it with a DialogFormHeader. */
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
		<DialogFormFrame width={width}>
			<DialogFormStep onSubmit={onSubmit}>{children}</DialogFormStep>
		</DialogFormFrame>
	);
}

/**
 * The dialog around a form that changes as you go, such as choosing a
 * provider and then entering its key. It stays put while the steps inside it,
 * each a DialogFormStep, swap, so the dialog does not close and open again.
 */
export function DialogFormFrame({
	width = "default",
	children,
}: {
	width?: keyof typeof widths;
	children: ReactNode;
}) {
	return (
		<DialogContent
			showCloseButton={false}
			className={cn("gap-0 overflow-hidden p-0", widths[width])}
		>
			{children}
		</DialogContent>
	);
}

/** One step's form inside a DialogFormFrame. Start it with a DialogFormHeader. */
export function DialogFormStep({
	onSubmit,
	children,
}: {
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
	children: ReactNode;
}) {
	return (
		// `min-w-0`: the popup is a grid, and a grid item is otherwise at least
		// as wide as its content's narrowest line. A line that does not wrap
		// would then widen the form past the dialog, which clips it, and the
		// right edge of every row would be cut off.
		<form onSubmit={onSubmit} className="flex min-w-0 flex-col">
			{children}
		</form>
	);
}

const headerText =
	"focus-ring rounded-md text-left text-[14.5px] text-link disabled:text-disabled-foreground";

/**
 * The dialog's only row of actions: Cancel, the title, and the submit action,
 * which stays faded until `actionDisabled` is false.
 *
 * Cancel closes the dialog unless `onCancel` is given. Pass `cancel={false}`
 * for a dialog that must be acknowledged rather than dismissed. `onBack` puts
 * Back in Cancel's place, for a step inside the dialog. A step that only
 * picks where to go next has no `action`.
 */
export function DialogFormHeader({
	title,
	action,
	actionDisabled = false,
	cancel = true,
	cancelDisabled = false,
	onCancel,
	onBack,
}: {
	title: string;
	action?: string;
	actionDisabled?: boolean;
	cancel?: boolean;
	cancelDisabled?: boolean;
	onCancel?: () => void;
	onBack?: () => void;
}) {
	return (
		<header className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-[18px] pt-4 pb-3">
			<span className="justify-self-start">
				{onBack ? (
					<button
						type="button"
						className={cn(headerText, "inline-flex items-center gap-0.5")}
						disabled={cancelDisabled}
						onClick={onBack}
					>
						<ChevronLeft aria-hidden size={16} strokeWidth={2.4} />
						Back
					</button>
				) : (
					cancel &&
					(onCancel ? (
						<button
							type="button"
							className={headerText}
							disabled={cancelDisabled}
							onClick={onCancel}
						>
							Cancel
						</button>
					) : (
						<DialogClose className={headerText} disabled={cancelDisabled}>
							Cancel
						</DialogClose>
					))
				)}
			</span>
			<DialogTitle className="text-center font-semibold text-[15px] text-foreground">
				{title}
			</DialogTitle>
			{action ? (
				<button
					type="submit"
					className={cn(headerText, "justify-self-end text-right font-semibold")}
					disabled={actionDisabled}
				>
					{action}
				</button>
			) : (
				<span />
			)}
		</header>
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
		<div
			className={cn("flex flex-col px-[18px] pt-1 pb-5", gap === "compact" ? "gap-3" : "gap-3.5")}
		>
			{children}
		</div>
	);
}
