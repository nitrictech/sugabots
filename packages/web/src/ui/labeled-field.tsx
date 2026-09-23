import type { ReactNode } from "react";

/** A labelled block: the label, an optional count beside it, an optional action at the far end. */
export function LabeledField({
	label,
	htmlFor,
	count,
	action,
	children,
}: {
	label: string;
	/** Names a form control; without it the label is plain text. */
	htmlFor?: string;
	count?: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	const heading = htmlFor ? (
		<label htmlFor={htmlFor} className="font-semibold text-md text-heading">
			{label}
		</label>
	) : (
		<span className="font-semibold text-md text-heading">{label}</span>
	);
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-baseline gap-2">
				{heading}
				{count !== undefined && <span className="text-sm text-muted-foreground">{count}</span>}
				{action !== undefined && <span className="ml-auto">{action}</span>}
			</div>
			{children}
		</div>
	);
}
