import type { ReactNode } from "react";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/ui/dialog.tsx";

export function DeleteDialog({
	open,
	onOpenChange,
	title,
	description,
	pending,
	error,
	confirmLabel = "Yes, delete",
	onDelete,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: ReactNode;
	pending: boolean;
	error?: string;
	/** Say what the button does when it isn't a deletion, e.g. "Yes, remove". */
	confirmLabel?: string;
	onDelete: () => void | Promise<void>;
}) {
	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!pending) onOpenChange(nextOpen);
			}}
		>
			<DialogContent showCloseButton={!pending} className="sm:max-w-md">
				<form
					className="contents"
					onSubmit={(event) => {
						event.preventDefault();
						void onDelete();
					}}
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</DialogHeader>
					{error && <Alert>{error}</Alert>}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={pending}
							onClick={() => onOpenChange(false)}
						>
							Keep
						</Button>
						<Button type="submit" variant="destructive" disabled={pending}>
							{confirmLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
