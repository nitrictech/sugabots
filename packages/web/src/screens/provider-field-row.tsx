import type { ReactNode } from "react";
import { SettingsControlRow } from "@/ui/settings-page.tsx";

/**
 * A row of a model provider's provider access: its label, then what it holds (a
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
		<SettingsControlRow label={label}>
			<span className="min-w-0 flex-1">{children}</span>
			{action}
		</SettingsControlRow>
	);
}

export const valueText = "block truncate font-mono text-xs text-foreground";

/** What stands for a saved key, which the API never sends back. */
export const savedKeyMask = "••••••••";
