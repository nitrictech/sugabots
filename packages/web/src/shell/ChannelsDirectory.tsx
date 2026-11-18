import type { Pod } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Lock, Plus } from "lucide-react";
import { useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { podLink } from "@/lib/links.ts";
import { useJoinPod, usePods } from "@/lib/pods.ts";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { NewPodDialog } from "@/shell/NewPod.tsx";
import { Page } from "@/shell/Page.tsx";
import { PodInitial } from "@/shell/SidebarPod.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";

/**
 * Every channel the person could be in: those they are in, then the public
 * ones they could join, each by name and what it's for, with Join or Open.
 * A + makes another.
 */
export function ChannelsDirectory() {
	const { data: pods, isPending, error } = usePods();
	const may = useWorkspacePermissions();
	const join = useJoinPod();
	const navigate = useNavigate();
	const [creating, setCreating] = useState(false);
	const yours = pods?.filter((pod) => pod.isMember) ?? [];
	const others = pods?.filter((pod) => !pod.isMember) ?? [];
	return (
		<Page
			title="Channels"
			place={{ kind: "tab" }}
			actions={
				may.createPods && (
					<IconButton label="New channel" variant="bar" onClick={() => setCreating(true)}>
						<Plus size={16} strokeWidth={1.75} />
					</IconButton>
				)
			}
		>
			<div className="mx-auto flex w-full max-w-180 flex-col gap-6 px-4 pt-6 pb-12">
				{error && <Alert>{failureMessage(error)}</Alert>}
				{join.error && <Alert>{failureMessage(join.error)}</Alert>}
				{!isPending && pods?.length === 0 && (
					<EmptyState title="No channels yet">
						{may.createPods
							? "Make the first one with the + above."
							: "Ask someone in the workspace to make one."}
					</EmptyState>
				)}
				{yours.length > 0 && (
					<SettingsGroup label="Yours" headingLevel={2}>
						{yours.map((pod) => (
							<ChannelRow key={pod.id} pod={pod} />
						))}
					</SettingsGroup>
				)}
				{others.length > 0 && (
					<SettingsGroup label="To join" headingLevel={2}>
						{others.map((pod) => (
							<ChannelRow
								key={pod.id}
								pod={pod}
								onJoin={
									pod.permissions.join
										? async () => {
												await join.mutateAsync(pod.id);
												await navigate(podLink(pod));
											}
										: undefined
								}
								joining={join.isPending && join.variables === pod.id}
							/>
						))}
					</SettingsGroup>
				)}
			</div>
			<Dialog open={creating} onOpenChange={setCreating}>
				<NewPodDialog
					onCreated={async (pod) => {
						setCreating(false);
						await navigate(podLink(pod));
					}}
				/>
			</Dialog>
		</Page>
	);
}

/** A channel in the directory: its mark, name and what it's for, opening it once you're in. */
function ChannelRow({
	pod,
	onJoin,
	joining = false,
}: {
	pod: Pod;
	/** Joins it, for a channel the viewer is not in and may join. */
	onJoin?: () => Promise<void>;
	joining?: boolean;
}) {
	const label = (
		<span className="flex min-w-0 items-center gap-1.5">
			<span className="truncate">{pod.name}</span>
			{pod.visibility === "private" && (
				<Lock aria-label="Private" size={11} strokeWidth={2.25} className="shrink-0" />
			)}
		</span>
	);
	if (pod.isMember) {
		return (
			<SettingsRow
				icon={<PodInitial pod={pod} />}
				label={label}
				sub={pod.description ?? undefined}
				chevron
				render={<Link {...podLink(pod)} />}
			/>
		);
	}
	return (
		<SettingsRow
			icon={<PodInitial pod={pod} />}
			label={label}
			sub={pod.description ?? undefined}
			trailing={
				onJoin && (
					<Button size="sm" variant="secondary" disabled={joining} onClick={() => void onJoin()}>
						Join
					</Button>
				)
			}
		/>
	);
}
