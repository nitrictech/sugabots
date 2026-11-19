import type { ReactNode } from "react";

/**
 * A row of a model provider's connection: its label, then what it holds (a
 * value in the mono face, or the field that changes it), and its actions,
 * such as Replace.
 */
export function ProviderFieldRow({
	label,
	children,
	action,
}: {
	label: string;
	children?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="flex min-h-14 items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0">
			<span className="w-27.5 shrink-0 text-sm text-muted-foreground">{label}</span>
			<span className="min-w-0 flex-1">{children}</span>
			{action}
		</div>
	);
}

export const valueText = "block truncate font-mono text-xs text-foreground";

/** What stands for a saved key, which the API never sends back. */
export const savedKeyMask = "••••••••";
