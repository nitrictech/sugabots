import { useId, useState } from "react";
import { savedKeyMask } from "./connection-row.tsx";

/**
 * A row that takes a value typed in place: a server's address, or a key. It
 * saves on Enter or when you leave it, and a secret shows only a mask once
 * saved, with Replace and Remove beside it.
 */
export function TextEntryRow({
	label,
	saved,
	placeholder,
	secret = false,
	clearable = false,
	disabled,
	onSave,
	onRemove,
}: {
	label: string;
	/** The stored value, or `undefined` when there is none. A secret's is never sent, so it is "". */
	saved: string | undefined;
	placeholder: string;
	secret?: boolean;
	/** Emptying it saves "", which clears it, rather than putting back what was saved. */
	clearable?: boolean;
	disabled: boolean;
	onSave: (value: string) => Promise<void>;
	onRemove?: () => void;
}) {
	const id = useId();
	const [replacing, setReplacing] = useState(false);
	const [draft, setDraft] = useState(secret ? "" : (saved ?? ""));
	const showingSecret = secret && saved !== undefined && !replacing;

	function commit() {
		const value = draft.trim();
		if (clearable && value === "" && saved !== undefined) {
			void onSave("");
			return;
		}
		if (value === "" || value === saved) {
			if (!secret) setDraft(saved ?? "");
			return;
		}
		void onSave(value).then(() => {
			if (secret) {
				setDraft("");
				setReplacing(false);
			}
		});
	}

	return (
		<div className="flex min-h-12 items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0">
			<label htmlFor={id} className="w-[82px] shrink-0 text-[14.5px] text-foreground">
				{label}
			</label>
			{showingSecret ? (
				<>
					<span
						id={id}
						className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-muted-foreground"
					>
						{savedKeyMask}
					</span>
					<button
						type="button"
						onClick={() => setReplacing(true)}
						disabled={disabled}
						className="focus-ring shrink-0 rounded-md font-medium text-link text-sm"
					>
						Replace
					</button>
					{onRemove && (
						<button
							type="button"
							onClick={onRemove}
							disabled={disabled}
							className="focus-ring shrink-0 rounded-md font-medium text-destructive-text text-sm"
						>
							Remove
						</button>
					)}
				</>
			) : (
				<input
					id={id}
					type={secret ? "password" : "text"}
					autoComplete="off"
					spellCheck={false}
					value={draft}
					placeholder={placeholder}
					disabled={disabled}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
						if (event.key === "Escape") {
							setDraft(secret ? "" : (saved ?? ""));
							setReplacing(false);
						}
					}}
					className="min-w-0 flex-1 rounded-md bg-transparent font-mono text-[13.5px] text-foreground outline-none placeholder:text-subtle-foreground focus-visible:shadow-(--ring-shadow)"
				/>
			)}
		</div>
	);
}
