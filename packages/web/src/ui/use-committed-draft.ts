import { type KeyboardEvent, useState } from "react";

/**
 * A field's text while it is edited, saved trimmed by `onCommit` when the field
 * is left or Enter is pressed. Escape, or leaving it unchanged, puts `saved`
 * back; so does leaving it blank unless `allowEmpty`, and a commit whose
 * promise rejects. While `pending`, a commit puts `saved` back rather than
 * saving over the save in flight.
 *
 * Spread `fieldProps` onto the input or textarea. Key the field by `saved`
 * where it can change elsewhere, so the new value replaces what was typed.
 */
export function useCommittedDraft(
	saved: string,
	onCommit: (value: string) => unknown,
	{ allowEmpty = false, pending = false }: { allowEmpty?: boolean; pending?: boolean } = {},
) {
	const [draft, setDraft] = useState(saved);

	function commit() {
		const next = draft.trim();
		if (pending || next === saved || (next === "" && !allowEmpty)) {
			setDraft(saved);
			return;
		}
		setDraft(next);
		const result = onCommit(next);
		if (result instanceof Promise) void result.catch(() => setDraft(saved));
	}

	return {
		draft,
		fieldProps: {
			value: draft,
			onChange: (event: { currentTarget: { value: string } }) =>
				setDraft(event.currentTarget.value),
			onBlur: commit,
			onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
				if (event.key === "Enter" && event.currentTarget instanceof HTMLInputElement) {
					event.currentTarget.blur();
				}
				if (event.key === "Escape" && draft !== saved) {
					// Undoing the edit takes this Escape, so a dialog around the field stays open.
					event.stopPropagation();
					setDraft(saved);
				}
			},
		},
	};
}
