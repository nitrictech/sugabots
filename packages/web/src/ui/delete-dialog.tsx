import { type ReactNode, useRef } from "react";
import { Alert } from "@/ui/alert.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog.tsx";

const choice =
	"focus-ring flex-1 p-3.25 text-sm transition-colors hover:bg-chip disabled:cursor-default disabled:opacity-50";

/** A confirmation with Cancel and a red action side by side, like a phone's alert. */
export function DeleteDialog({
	open,
	onOpenChange,
	title,
	description,
	pending,
	error,
	confirmLabel = "Delete",
	onDelete,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: ReactNode;
	pending: boolean;
	error?: string;
	/** Say what the button does when it isn't a deletion, e.g. "Remove". */
	confirmLabel?: string;
	onDelete: () => void | Promise<void>;
}) {
	const cancel = useRef<HTMLButtonElement>(null);
	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!pending) onOpenChange(nextOpen);
			}}
		>
			{/* Cancel takes the focus so a stray Enter can't delete. */}
			<DialogContent
				showCloseButton={false}
				initialFocus={cancel}
				className="max-w-dialog-sm gap-0 overflow-hidden rounded-3xl p-0 text-center sm:max-w-90"
			>
				<form
					className="contents"
					onSubmit={(event) => {
						event.preventDefault();
						void onDelete();
					}}
				>
					<div className="flex flex-col items-center gap-2 px-5.5 pt-6 pb-4.5">
						<DialogTitle className="text-sm">{title}</DialogTitle>
						<DialogDescription className="text-xs text-pretty leading-normal">
							{description}
						</DialogDescription>
						{error && <Alert className="mt-2 text-left">{error}</Alert>}
					</div>
					<div className="flex border-border-strong border-t">
						<button
							ref={cancel}
							type="button"
							className={`${choice} border-border-strong border-r font-medium text-soft-foreground`}
							disabled={pending}
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</button>
						<button
							type="submit"
							className={`${choice} font-semibold text-destructive-text`}
							disabled={pending}
						>
							{confirmLabel}
						</button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
