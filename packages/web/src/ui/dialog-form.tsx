import { cn } from "cn";
import { ChevronLeft, X } from "lucide-react";
import {
	createContext,
	type FormEvent,
	type ReactNode,
	use,
	useEffect,
	useRef,
	useState,
} from "react";
import { matchesMedia, SIDE_BY_SIDE } from "@/lib/media.ts";
import { BACK_BUTTON, BACK_LABEL_ON_PHONE, BACK_ON_PHONE } from "@/ui/back-button.tsx";
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
	const frame = useRef<HTMLDivElement>(null);
	return (
		<DialogContent
			ref={frame}
			// On a phone, opened other than from the keyboard, as by a tap, the dialog itself takes focus rather
			// than its first control, a phone's Close at the top left, which would be ringed as if chosen.
			initialFocus={(openType) =>
				openType === "keyboard" || matchesMedia(SIDE_BY_SIDE) ? true : frame.current
			}
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

/**
 * How a step's footer has its Cancel, for a phone's Close in the header to do
 * as it does: be there only when Cancel is, wait while Cancel waits, and run
 * the step's own `onCancel` when it has one.
 */
interface StepCancel {
	shown: boolean;
	disabled: boolean;
	/** Whether Cancel runs the step's own `onCancel`, kept in `onCancel` of `StepCancelLink`, rather than closing. */
	ownAction: boolean;
}

/** A step's Cancel as its footer last said it, and that footer's `onCancel`. */
interface StepCancelLink {
	cancel: StepCancel | undefined;
	setCancel: (cancel: StepCancel) => void;
	onCancel: { current: (() => void) | undefined };
}

const StepCancelContext = createContext<StepCancelLink | undefined>(undefined);

/** One step's form inside a DialogFormFrame. Start it with a DialogFormHeader and end it with a DialogFormFooter. */
export function DialogFormStep({
	onSubmit,
	children,
}: {
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
	children: ReactNode;
}) {
	// Undefined while the step has no footer, which leaves Close to close the dialog.
	const [cancel, setCancel] = useState<StepCancel>();
	const onCancel = useRef<(() => void) | undefined>(undefined);
	return (
		<StepCancelContext value={{ cancel, setCancel, onCancel }}>
			{/*
			 * `min-h-0`: a flex item is otherwise at least as tall as its content, so
			 * a long body would make the form taller than the dialog instead of
			 * scrolling inside it.
			 */}
			<form onSubmit={onSubmit} className="flex min-h-0 flex-col max-md:flex-1">
				{children}
			</form>
		</StepCancelContext>
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
						aria-label="Back"
						className={cn(
							"focus-ring inline-flex items-center gap-0.5 rounded-md text-left text-[14.5px] text-link disabled:text-disabled-foreground",
							BACK_ON_PHONE,
						)}
						disabled={backDisabled}
						onClick={onBack}
					>
						<ChevronLeft aria-hidden size={16} strokeWidth={2.4} className="max-md:size-[22px]" />
						<span className={BACK_LABEL_ON_PHONE}>Back</span>
					</button>
				)}
				{/* On a phone, where the dialog is the screen, the way out is at the top left, as a page's is. */}
				{!onBack && <PhoneClose />}
			</span>
			<DialogTitle className="text-center font-semibold text-[15px] text-foreground max-md:text-[17px]">
				{title}
			</DialogTitle>
			<span className="flex justify-self-end">
				{onClose && <CloseButton onClick={onClose} className="-mr-1.5 max-md:hidden" />}
			</span>
		</header>
	);
}

/**
 * A phone's Close, at the top left in place of the footer's Cancel, which a
 * phone hides: there only when Cancel is, waiting while it waits, and doing
 * what it does. A step with no footer is closed by it.
 */
function PhoneClose() {
	const step = use(StepCancelContext);
	const cancel = step?.cancel;
	if (cancel && !cancel.shown) return null;
	const className = cn(BACK_BUTTON, "md:hidden disabled:opacity-50");
	const icon = <X aria-hidden size={20} strokeWidth={2.25} />;
	if (cancel?.ownAction) {
		return (
			<button
				type="button"
				aria-label="Close"
				disabled={cancel.disabled}
				onClick={() => step?.onCancel.current?.()}
				className={className}
			>
				{icon}
			</button>
		);
	}
	return (
		<DialogClose aria-label="Close" disabled={cancel?.disabled} className={className}>
			{icon}
		</DialogClose>
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
	// Said up to the header, whose Close stands in for Cancel on a phone.
	const step = use(StepCancelContext);
	useEffect(() => {
		if (step) step.onCancel.current = onCancel;
	});
	const ownAction = onCancel !== undefined;
	const setCancel = step?.setCancel;
	useEffect(() => {
		setCancel?.({ shown: cancel, disabled: cancelDisabled, ownAction });
	}, [setCancel, cancel, cancelDisabled, ownAction]);
	return (
		// On a phone, at the foot of the screen, its buttons shared out across it and sized for a thumb.
		<footer
			className={cn(
				"flex justify-end gap-2 px-[18px] pb-[18px] max-md:mt-auto max-md:px-4 max-md:pt-3 max-md:pb-[max(16px,env(safe-area-inset-bottom))] max-md:*:h-11 max-md:*:flex-1 max-md:*:text-[15px]",
				// Holding only Cancel, which a phone leaves to the header, it takes no room there.
				!action && !beside && "max-md:hidden",
			)}
		>
			{beside}
			{/* A phone's way out is the header's, at the top left. */}
			{cancel &&
				(onCancel ? (
					<Button
						type="button"
						variant="secondary"
						disabled={cancelDisabled}
						onClick={onCancel}
						className="max-md:hidden"
					>
						Cancel
					</Button>
				) : (
					<DialogClose
						render={<Button variant="secondary" className="max-md:hidden" />}
						disabled={cancelDisabled}
					>
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
