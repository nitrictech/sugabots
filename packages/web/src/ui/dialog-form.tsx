import { cn } from "cn";
import { ChevronLeft } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { Button } from "@/ui/button.tsx";
import { CloseButton } from "@/ui/close-button.tsx";
import { DialogClose, DialogContent, DialogTitle } from "@/ui/dialog.tsx";

const widths = {
	compact: "max-w-[420px] sm:max-w-[420px]",
	default: "max-w-[460px] sm:max-w-[460px]",
	/** For writing at length, such as a routine's instructions. */
	wide: "max-w-[640px] sm:max-w-[640px]",
} as const;

/** DialogForm renders a modal form inside Dialog. Start it with a DialogFormHeader and end it with a DialogFormFooter. */
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
 *
 * It is never taller than the screen: a body too long to fit scrolls between
 * the header and footer, which stay in view. On a phone it is the screen, as
 * tall as the keyboard leaves, so its actions sit just above the keyboard
 * rather than behind it.
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
			className={cn(
				"flex max-h-[calc(100dvh-20px)] flex-col gap-0 overflow-hidden p-0",
				widths[width],
				"max-md:inset-0 max-md:h-[var(--visible-height,100dvh)] max-md:max-h-none max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none",
			)}
		>
			{children}
		</DialogContent>
	);
}

/** One step's form inside a DialogFormFrame. Start it with a DialogFormHeader and end it with a DialogFormFooter. */
export function DialogFormStep({
	onSubmit,
	children,
}: {
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
	children: ReactNode;
}) {
	return (
		// `min-h-0`: a flex item is otherwise at least as tall as its content, so
		// a long body would make the form taller than the dialog instead of
		// scrolling inside it.
		<form onSubmit={onSubmit} className="flex min-h-0 flex-col max-md:flex-1">
			{children}
		</form>
	);
}

/**
 * The dialog's title. `onBack` puts Back beside it, for a step inside the
 * dialog; `backDisabled` holds it while the step is saving. `onClose` puts a
 * close button in the corner, for a step with no footer, such as one that
 * only picks where to go next.
 */
export function DialogFormHeader({
	title,
	onBack,
	backDisabled = false,
	onClose,
}: {
	title: string;
	onBack?: () => void;
	backDisabled?: boolean;
	onClose?: () => void;
}) {
	return (
		<header className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-[18px] pt-4 pb-3 max-md:px-4 max-md:pt-[max(16px,env(safe-area-inset-top))]">
			{/* `flex`: an inline span would set Back on a line of text, taller than the title, so the header would grow with it. */}
			<span className="flex justify-self-start">
				{onBack && (
					<button
						type="button"
						className="focus-ring inline-flex items-center gap-0.5 rounded-md text-left text-[14.5px] text-link disabled:text-disabled-foreground"
						disabled={backDisabled}
						onClick={onBack}
					>
						<ChevronLeft aria-hidden size={16} strokeWidth={2.4} />
						Back
					</button>
				)}
			</span>
			<DialogTitle className="text-center font-semibold text-[15px] text-foreground max-md:text-[17px]">
				{title}
			</DialogTitle>
			<span className="flex justify-self-end">
				{onClose && <CloseButton onClick={onClose} className="-mr-1.5" />}
			</span>
		</header>
	);
}

/**
 * The dialog's actions, after its body: Cancel, then the submit action, which
 * stays disabled until `actionDisabled` is false.
 *
 * Cancel closes the dialog unless `onCancel` is given. Pass `cancel={false}`
 * for a dialog that must be acknowledged rather than dismissed, or for a step
 * whose header has Back. A step that only picks where to go next has no
 * `action`.
 */
export function DialogFormFooter({
	action,
	actionDisabled = false,
	cancel = true,
	cancelDisabled = false,
	onCancel,
	beside,
}: {
	/** A button shown before Cancel and the action, such as Test. */
	beside?: ReactNode;
	action?: string;
	actionDisabled?: boolean;
	cancel?: boolean;
	cancelDisabled?: boolean;
	onCancel?: () => void;
}) {
	return (
		// On a phone, at the foot of the screen, its buttons shared out across it and sized for a thumb.
		<footer className="flex justify-end gap-2 px-[18px] pb-[18px] max-md:mt-auto max-md:px-4 max-md:pt-3 max-md:pb-[max(16px,env(safe-area-inset-bottom))] max-md:*:h-11 max-md:*:flex-1 max-md:*:text-[15px]">
			{beside}
			{cancel &&
				(onCancel ? (
					<Button type="button" variant="secondary" disabled={cancelDisabled} onClick={onCancel}>
						Cancel
					</Button>
				) : (
					<DialogClose render={<Button variant="secondary" />} disabled={cancelDisabled}>
						Cancel
					</DialogClose>
				))}
			{action && (
				<Button type="submit" disabled={actionDisabled}>
					{action}
				</Button>
			)}
		</footer>
	);
}

/**
 * Everything between the header and footer. It is the only part of the dialog
 * that scrolls when the dialog would be taller than the screen, so anything
 * that can grow belongs here; content outside it is cut off.
 */
export function DialogFormBody({
	gap = "default",
	children,
}: {
	gap?: "compact" | "default";
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex min-h-0 flex-col overflow-x-hidden overflow-y-auto px-[18px] pt-1 pb-5 max-md:flex-1 max-md:px-4",
				gap === "compact" ? "gap-3" : "gap-3.5",
			)}
		>
			{children}
		</div>
	);
}
