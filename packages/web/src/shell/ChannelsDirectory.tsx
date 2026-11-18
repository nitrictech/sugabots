import type { Channel } from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Lock, Plus } from "lucide-react";
import { useState } from "react";
import { useChannels, useJoinChannel } from "@/lib/channels.ts";
import { failureMessage } from "@/lib/failure.ts";
import { channelLink } from "@/lib/links.ts";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { NewChannelDialog } from "@/shell/NewChannel.tsx";
import { Page } from "@/shell/Page.tsx";
import { ChannelInitial } from "@/shell/SidebarChannel.tsx";
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
	const { data: channels, isPending, error } = useChannels();
	const may = useWorkspacePermissions();
	const join = useJoinChannel();
	const navigate = useNavigate();
	const [creating, setCreating] = useState(false);
	const yours = channels?.filter((channel) => channel.isMember) ?? [];
	const others = channels?.filter((channel) => !channel.isMember) ?? [];
	return (
		<Page
			title="Channels"
			place={{ kind: "tab" }}
			actions={
				may.createChannels && (
					<IconButton label="New channel" variant="bar" onClick={() => setCreating(true)}>
						<Plus size={16} strokeWidth={1.75} />
					</IconButton>
				)
			}
		>
			<div className="mx-auto flex w-full max-w-180 flex-col gap-6 px-4 pt-6 pb-12">
				{error && <Alert>{failureMessage(error)}</Alert>}
				{join.error && <Alert>{failureMessage(join.error)}</Alert>}
				{!isPending && channels?.length === 0 && (
					<EmptyState title="No channels yet">
						{may.createChannels
							? "Make the first one with the + above."
							: "Ask someone in the workspace to make one."}
					</EmptyState>
				)}
				{yours.length > 0 && (
					<SettingsGroup label="Yours" headingLevel={2}>
						{yours.map((channel) => (
							<ChannelRow key={channel.id} channel={channel} />
						))}
					</SettingsGroup>
				)}
				{others.length > 0 && (
					<SettingsGroup label="To join" headingLevel={2}>
						{others.map((channel) => (
							<ChannelRow
								key={channel.id}
								channel={channel}
								onJoin={
									channel.permissions.join
										? () =>
												// Why it failed shows above the list.
												join.mutate(channel.id, {
													onSuccess: () => void navigate(channelLink(channel)),
												})
										: undefined
								}
								joining={join.isPending && join.variables === channel.id}
							/>
						))}
					</SettingsGroup>
				)}
			</div>
			<Dialog open={creating} onOpenChange={setCreating}>
				<NewChannelDialog
					onCreated={async (channel) => {
						setCreating(false);
						await navigate(channelLink(channel));
					}}
				/>
			</Dialog>
		</Page>
	);
}

/** A channel in the directory: its mark, name and what it's for, opening it once you're in. */
function ChannelRow({
	channel,
	onJoin,
	joining = false,
}: {
	channel: Channel;
	/** Joins it, for a channel the viewer is not in and may join. */
	onJoin?: () => void;
	joining?: boolean;
}) {
	const label = (
		<span className="flex min-w-0 items-center gap-1.5">
			<span className="truncate">{channel.name}</span>
			{channel.visibility === "private" && (
				<Lock role="img" aria-label="Private" size={11} strokeWidth={2.25} className="shrink-0" />
			)}
		</span>
	);
	if (channel.isMember) {
		return (
			<SettingsRow
				icon={<ChannelInitial channel={channel} />}
				label={label}
				sub={channel.description ?? undefined}
				chevron
				render={<Link {...channelLink(channel)} />}
			/>
		);
	}
	return (
		<SettingsRow
			icon={<ChannelInitial channel={channel} />}
			label={label}
			sub={channel.description ?? undefined}
			trailing={
				onJoin && (
					<Button
						size="sm"
						variant="secondary"
						aria-label={`Join ${channel.name}`}
						disabled={joining}
						onClick={onJoin}
					>
						Join
					</Button>
				)
			}
		/>
	);
}
