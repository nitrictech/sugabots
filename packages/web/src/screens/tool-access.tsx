import type { ConnectorAccess, ToolAccessCounts } from "@sugabots/contracts";
import { TOOL_ACCESS_LABELS } from "@/lib/tool-access-labels.ts";
import { SegmentedControl } from "@/ui/segmented-control.tsx";

/*
 * Allowed, Ask first and Off as a connector's settings show them: a line
 * summing up its tools for the project's list, and a pick-one row for a tool, or
 * a kind of tool, on the connector's own page.
 */

const ACCESSES = ["allow", "ask", "off"] as const;

const toolOptions = ACCESSES.map((value) => ({ value, label: TOOL_ACCESS_LABELS[value] }));

/**
 * What a connector's tools amount to, in a line: the setting they share, or
 * how many are at each when they differ. Undefined while it has no tools.
 */
export function accessSummaryText(counts: ToolAccessCounts): string | undefined {
	const total = counts.allow + counts.ask + counts.off;
	if (total === 0) return undefined;
	switch (ACCESSES.find((access) => counts[access] === total)) {
		case "allow":
			return "Every tool runs without asking";
		case "ask":
			return "Every tool asks first";
		case "off":
			return "Off for every bot";
		case undefined: {
			const parts = ACCESSES.filter((access) => counts[access] > 0).map(
				(access) => `${counts[access]} ${TOOL_ACCESS_LABELS[access].toLowerCase()}`,
			);
			return `Custom: ${parts.join(", ")}`;
		}
	}
}

/**
 * Allowed, Ask first or Off for one tool, or for a kind of tool at once.
 * Somebody who may not change it reads the setting instead.
 */
export function AccessToggle({
	label,
	value,
	canManage,
	onChange,
}: {
	/** What it sets, which names the control: a tool's name, or Tools that read. */
	label: string;
	value: ConnectorAccess;
	canManage: boolean;
	onChange: (access: ConnectorAccess) => void;
}) {
	if (!canManage) {
		return (
			<span className="shrink-0 text-xs text-muted-foreground">{TOOL_ACCESS_LABELS[value]}</span>
		);
	}
	return <SegmentedControl label={label} options={toolOptions} value={value} onChange={onChange} />;
}
