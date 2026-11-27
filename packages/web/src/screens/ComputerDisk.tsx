import {
	type ComputerDisk,
	computerDiskLevel,
	computerDiskPercent,
	formatDiskSize,
} from "@sugabots/contracts";
import { Meter } from "@/ui/meter.tsx";
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

/** How full a computer's disk is, as a thin bar that turns amber, then red, as it fills. */
export function DiskMeter({ disk, label }: { disk: ComputerDisk; label: string }) {
	const percent = computerDiskPercent(disk);
	return (
		<Meter
			aria-label={label}
			value={percent}
			className="my-1.5"
			indicatorClassName={BAR_COLORS[computerDiskLevel(disk)]}
		/>
	);
}

/** The share of the disk in use, coloured as {@link DiskMeter} is once it nears full. */
export function DiskPercent({ disk }: { disk: ComputerDisk }) {
	return (
		<SettingsValue>
			<span className={PERCENT_COLORS[computerDiskLevel(disk)]}>{computerDiskPercent(disk)}%</span>
		</SettingsValue>
	);
}

/** Such as "18.4 GB of 20 GB". */
export function diskSummary(disk: ComputerDisk) {
	return `${formatDiskSize(disk.usedBytes)} of ${formatDiskSize(disk.totalBytes)}`;
}
