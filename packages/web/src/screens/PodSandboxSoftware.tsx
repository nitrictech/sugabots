import type { PodSandboxSoftware } from "@sugabots/contracts";
import { X } from "lucide-react";
import { failureMessage } from "@/lib/failure.ts";
import { usePodSandboxSoftware } from "@/lib/pod-sandbox.ts";
import { Alert } from "@/ui/alert.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "@/ui/settings-page.tsx";

/**
 * The software the pod's sandbox has beyond its image: packages from nixpkgs
 * its agents asked for and someone allowed, which every sandbox the pod has
 * is given. `canManage` is whether the person may remove them.
 */
export function PodSandboxSoftwareSettings({
	podId,
	canManage,
}: {
	podId: string;
	canManage: boolean;
}) {
	const { software, removePackage } = usePodSandboxSoftware(podId);
	if (software.isPending) return null;
	if (software.isError) return <Alert>{failureMessage(software.error)}</Alert>;
	return (
		<SoftwareGroup
			software={software.data}
			canManage={canManage}
			pending={removePackage.isPending}
			error={removePackage.error ?? undefined}
			onRemove={(name, channel) => removePackage.mutate({ name, channel })}
		/>
	);
}

export function SoftwareGroup({
	software,
	canManage,
	pending,
	error,
	onRemove,
}: {
	software: PodSandboxSoftware;
	canManage: boolean;
	pending: boolean;
	error?: unknown;
	onRemove: (name: string, channel: PodSandboxSoftware["packages"][number]["channel"]) => void;
}) {
	return (
		<>
			<SettingsGroup
				label="Software"
				note="Packages from nixpkgs beyond the sandbox's image. A bot asks for one in its thread, and an admin of this pod can allow it; every sandbox the pod has gets them."
			>
				{software.packages.length === 0 && (
					<SettingsRow
						label="None yet"
						sub="Bots install what they need for a single command without asking."
					/>
				)}
				{software.packages.map((item) => (
					<SettingsRow
						key={`${item.channel}:${item.name}`}
						label={<span className="font-mono text-[13.5px]">{item.name}</span>}
						sub={`Allowed by ${item.addedByName ?? "someone who has left"}`}
						trailing={
							<span className="flex items-center gap-2">
								{item.channel === "unstable" && <SettingsValue>Unstable</SettingsValue>}
								{canManage && (
									<IconButton
										label={`Remove ${item.name}`}
										disabled={pending}
										onClick={() => onRemove(item.name, item.channel)}
									>
										<X size={16} />
									</IconButton>
								)}
							</span>
						}
					/>
				))}
			</SettingsGroup>
			{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
		</>
	);
}
