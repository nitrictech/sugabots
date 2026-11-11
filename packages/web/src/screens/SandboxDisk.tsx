import {
	formatDiskSize,
	type SandboxDisk,
	sandboxDiskLevel,
	sandboxDiskPercent,
} from "@sugabots/contracts";
import { cn } from "cn";
import { SettingsValue } from "@/ui/settings-page.tsx";

/** The bar's colour at each level: red only once commands are about to fail. */
const BAR_COLORS = {
	normal: "bg-meter",
	warning: "bg-warning",
	critical: "bg-destructive",
} as const;

const PERCENT_COLORS = {
	normal: undefined,
	warning: "text-warning",
	critical: "text-destructive-text",
} as const;

/** How full a sandbox's disk is, as a thin bar that turns amber, then red, as it fills. */
export function DiskMeter({ disk, label }: { disk: SandboxDisk; label: string }) {
	const percent = sandboxDiskPercent(disk);
	return (
		<>
			{/* The native meter can't be styled across browsers, so it is read out and the bar drawn. */}
			<meter className="sr-only" aria-label={label} min={0} max={100} value={percent} />
			<span aria-hidden className="my-1.5 block h-1 rounded-full bg-chip-strong">
				<span
					className={cn("block h-full rounded-full", BAR_COLORS[sandboxDiskLevel(disk)])}
					style={{ width: `${percent}%` }}
				/>
			</span>
		</>
	);
}

/** The share of the disk in use, coloured as {@link DiskMeter} is once it nears full. */
export function DiskPercent({ disk }: { disk: SandboxDisk }) {
	return (
		<SettingsValue>
			<span className={PERCENT_COLORS[sandboxDiskLevel(disk)]}>{sandboxDiskPercent(disk)}%</span>
		</SettingsValue>
	);
}

/** Such as "18.4 GB of 20 GB". */
export function diskSummary(disk: SandboxDisk) {
	return `${formatDiskSize(disk.usedBytes)} of ${formatDiskSize(disk.totalBytes)}`;
}
