import type { ReactNode } from "react";

/*
 * A form field: its label above it, as the design draws them.
 *
 * The control carries its own id rather than being nested inside the label, so
 * the pairing is one a screen reader, a test and a linter can all see. `id` is
 * required for that reason — a field with no id is a field with no label.
 */

export function Field({
	id,
	label,
	children,
}: {
	id: string;
	label: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<label htmlFor={id} className="font-semibold text-heading text-xs">
				{label}
			</label>
			{children}
		</div>
	);
}
