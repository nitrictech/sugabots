import type { ReactNode } from "react";

/** A label, its value in the mono face, and Replace, which turns the value into a field. */
export function ConnectionRow({
	label,
	children,
	action,
}: {
	label: string;
	children: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="flex min-h-[46px] items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0">
			<span className="w-[110px] shrink-0 text-[14px] text-muted-foreground">{label}</span>
			<span className="min-w-0 flex-1">{children}</span>
			{action}
		</div>
	);
}

export const valueText = "block truncate font-mono text-[13.5px] text-foreground";

/** What stands for a saved key, which the API never sends back. */
export const savedKeyMask = "••••••••";
