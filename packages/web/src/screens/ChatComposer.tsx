import { cn } from "cn";
import { ArrowUp, Plus } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId } from "react";

/**
 * Where a message is written: a + for attachments, then a pill that grows with
 * its text and sends on Enter (Shift+Enter for a new line). The send button
 * takes the accent once there is something to send.
 */
export function ChatComposer({
	label,
	placeholder,
	value,
	onValueChange,
	onSubmit,
	submitLabel,
	submitDisabled,
	error,
	className,
}: {
	label: string;
	placeholder: string;
	value: string;
	onValueChange: (value: string) => void;
	onSubmit: () => void | Promise<void>;
	submitLabel: string;
	submitDisabled: boolean;
	error?: ReactNode;
	className?: string;
}) {
	const id = useId();

	function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		event.currentTarget.form?.requestSubmit();
	}

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				void onSubmit();
			}}
			className={cn("flex shrink-0 flex-col gap-1.5", className)}
		>
			<div className="flex items-end gap-2.5">
				<button
					type="button"
					disabled
					aria-label="Add attachment"
					title="Attachments are not available yet"
					className="grid size-[38px] shrink-0 place-items-center rounded-full bg-chip text-soft-foreground disabled:cursor-not-allowed"
				>
					<Plus size={18} strokeWidth={2.2} />
				</button>
				<div className="focus-ring-within flex min-w-0 flex-1 items-end gap-2 rounded-composer border border-border-strong bg-panel py-1 pr-[5px] pl-4">
					<label htmlFor={id} className="sr-only">
						{label}
					</label>
					<textarea
						id={id}
						value={value}
						onChange={(event) => onValueChange(event.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={placeholder}
						maxLength={20_000}
						rows={1}
						required
						className="field-sizing-content block max-h-40 min-h-9 min-w-0 flex-1 resize-none bg-transparent py-[7px] text-foreground text-lg leading-[22px] outline-none placeholder:text-subtle-foreground"
					/>
					<button
						type="submit"
						aria-label={submitLabel}
						disabled={submitDisabled}
						className={cn(
							"focus-ring mb-0.5 grid size-8 shrink-0 place-items-center rounded-full text-white transition-colors",
							value.trim() ? "bg-switch-on hover:bg-primary" : "bg-border-strong",
						)}
					>
						<ArrowUp size={16} strokeWidth={2.6} />
					</button>
				</div>
			</div>
			<div aria-live="polite" className="pl-12 text-destructive-text text-sm empty:hidden">
				{error}
			</div>
		</form>
	);
}
