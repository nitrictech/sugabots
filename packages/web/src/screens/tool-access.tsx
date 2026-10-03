import type { ConnectionAccess, ToolAccessCounts } from "@sugabots/contracts";
import { cn } from "cn";
import { Ban, ChevronDown, CircleCheck, Ellipsis, Hand } from "lucide-react";
import type { ReactNode } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";

/*
 * Allow, Ask and Off as a connection's settings show them: a menu for several
 * tools at once, which reads Custom while they differ, and a pick-one row for
 * one tool.
 */

/** Several tools' access as one setting: the one they share, or `custom` when they differ. */
export type AccessSetting = ConnectionAccess | "custom";

const accessLabel: Record<AccessSetting, string> = {
	allow: "Allow",
	ask: "Ask",
	off: "Off",
	custom: "Custom",
};

const accessIcon: Record<AccessSetting, ReactNode> = {
	allow: <CircleCheck aria-hidden />,
	ask: <Hand aria-hidden />,
	off: <Ban aria-hidden />,
	custom: <Ellipsis aria-hidden />,
};

const ACCESSES = ["allow", "ask", "off"] as const;

const toolOptions = ACCESSES.map((value) => ({ value, label: accessLabel[value] }));

/** How many of a connection's tools are at each setting, in the order the sentence gives them. */
const COUNTED: { access: ConnectionAccess; words: string }[] = [
	{ access: "allow", words: "allowed" },
	{ access: "ask", words: "ask first" },
	{ access: "off", words: "off" },
];

/** What tools at these counts amount to, as one setting, or nothing when there are none. */
export function accessSettingOf(counts: ToolAccessCounts): AccessSetting | undefined {
	const total = counts.allow + counts.ask + counts.off;
	if (total === 0) return undefined;
	return ACCESSES.find((access) => counts[access] === total) ?? "custom";
}

/**
 * What a connection's tools amount to, in a line: the setting they share, or
 * how many are at each when they differ. Undefined while it has no tools.
 */
export function accessSummaryText(counts: ToolAccessCounts): string | undefined {
	switch (accessSettingOf(counts)) {
		case undefined:
			return undefined;
		case "allow":
			return "Every tool runs without asking";
		case "ask":
			return "Every tool asks first";
		case "off":
			return "Off for every bot";
		case "custom": {
			const parts = COUNTED.filter(({ access }) => counts[access] > 0).map(
				({ access, words }) => `${counts[access]} ${words}`,
			);
			return `Custom: ${parts.join(", ")}`;
		}
	}
}

const settingLook =
	"flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] px-2.5 font-medium text-[13px] [&_svg]:size-4";

function SettingFace({ value }: { value: AccessSetting }) {
	return (
		<>
			{accessIcon[value]}
			<span>{accessLabel[value]}</span>
		</>
	);
}

/** Several tools' setting, to read, for somebody who may not change it or a row too narrow for the menu. */
export function AccessValue({ value, className }: { value: AccessSetting; className?: string }) {
	return (
		<span className={cn(settingLook, "text-muted-foreground", className)}>
			<SettingFace value={value} />
		</span>
	);
}

/**
 * Allow, Ask or Off for several tools at once, as a menu that reads Custom
 * while they differ. Choosing Custom sets nothing: it calls `onCustom`, which
 * shows the tools so each can be set.
 */
export function AccessMenu({
	label,
	value,
	onChange,
	onCustom,
	className,
}: {
	/** Names the menu for assistive technology, such as "Linear, all tools". */
	label: string;
	value: AccessSetting;
	onChange: (access: ConnectionAccess) => void;
	onCustom: () => void;
	className?: string;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`${label}: ${accessLabel[value]}`}
				className={cn(
					settingLook,
					"focus-ring cursor-pointer bg-chip text-foreground transition-colors hover:bg-hover",
					className,
				)}
			>
				<SettingFace value={value} />
				<ChevronDown aria-hidden className="text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-48">
				<DropdownMenuRadioGroup
					value={value}
					onValueChange={(chosen: AccessSetting) =>
						chosen === "custom" ? onCustom() : onChange(chosen)
					}
				>
					{[...ACCESSES, "custom" as const].map((setting) => (
						<DropdownMenuRadioItem key={setting} value={setting}>
							{accessIcon[setting]}
							{accessLabel[setting]}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Allow, Ask or Off for one tool. Somebody who may not change it reads the setting instead. */
export function AccessToggle({
	label,
	value,
	canManage,
	onChange,
}: {
	/** The tool's name, which names the control. */
	label: string;
	value: ConnectionAccess;
	canManage: boolean;
	onChange: (access: ConnectionAccess) => void;
}) {
	if (!canManage) {
		return (
			<span className="shrink-0 font-medium text-[13px] text-muted-foreground">
				{accessLabel[value]}
			</span>
		);
	}
	return <SegmentedControl label={label} options={toolOptions} value={value} onChange={onChange} />;
}
