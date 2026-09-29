import type { Pod } from "@sugabots/contracts";
import { Link, useRouter } from "@tanstack/react-router";
import { Link2, Plus, Settings } from "lucide-react";
import { podLink, podSettingsLink } from "@/lib/links.ts";
import type { useBackToHere } from "@/lib/settings-back.tsx";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/ui/dropdown-menu.tsx";

/**
 * What right-clicking a pod offers: a new bot in it, its settings, and, for a
 * shared pod, its address to send somebody else.
 */
export function PodMenuItems({
	pod,
	settingsBack,
	onNewBot,
}: {
	pod: Pod;
	/** History state for the settings link, so its Back returns to the page it left. */
	settingsBack?: ReturnType<typeof useBackToHere>;
	/** Absent when the viewer may not add a bot to this pod. */
	onNewBot?: () => void;
}) {
	const router = useRouter();
	function copyLink() {
		const href = router.buildLocation(podLink(pod)).href;
		void navigator.clipboard?.writeText(new URL(href, window.location.origin).href).catch(() => {});
	}
	return (
		<>
			{onNewBot && (
				<>
					<DropdownMenuItem onClick={onNewBot}>
						<Plus />
						New bot
					</DropdownMenuItem>
					<DropdownMenuSeparator />
				</>
			)}
			<DropdownMenuItem render={<Link {...podSettingsLink(pod)} state={settingsBack} />}>
				<Settings />
				Pod settings
			</DropdownMenuItem>
			{pod.kind === "shared" && (
				<DropdownMenuItem onClick={copyLink}>
					<Link2 />
					Copy link
				</DropdownMenuItem>
			)}
		</>
	);
}
