import {
	CHANNEL_DESCRIPTION_MAX_LENGTH,
	CHANNEL_NAME_MAX_LENGTH,
	type Channel,
	type ChannelMember,
	workspaceRoleLabel,
} from "@sugabots/contracts";
import { Link, linkOptions, useNavigate, useRouter } from "@tanstack/react-router";
import { Minus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useBots } from "@/lib/bots.ts";
import {
	useChannelBots,
	useChannelMembers,
	useChannels,
	useDeleteChannel,
	useLeaveChannel,
	usePlaceChannelBot,
	usePlaceChannelMember,
	useUpdateChannel,
} from "@/lib/channels.ts";
import { failureMessage } from "@/lib/failure.ts";
import { botSettingsLink } from "@/lib/links.ts";
import { useSession } from "@/lib/session.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspaceMembers } from "@/lib/workspace.ts";
import type { ChannelSettingsPage } from "@/lib/workspace-settings.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { ChannelColourPicker } from "@/shell/LookPicker.tsx";
import { useNewBot } from "@/shell/NewBot.tsx";
import { ChannelInitial } from "@/shell/SidebarChannel.tsx";
import { Alert } from "@/ui/alert.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { useLeave } from "@/ui/back-button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import {
	SettingsAddButton,
	SettingsControlRow,
	SettingsDanger,
	SettingsGroup,
	SettingsNameRow,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/**
 * One channel's settings, a page at a time as the navigation lists them:
 * General, its people, and its bots. Only public bots can be added, and a bot
 * made private leaves its channels.
 */
export function WorkspaceChannelsSettings({
	selectedChannelId,
	channelPage = "general",
	canCreateChannels,
}: {
	selectedChannelId?: string;
	channelPage?: ChannelSettingsPage;
	canCreateChannels: boolean;
}) {
	const { data: channels, isPending, error } = useChannels();
	// With none chosen, the first the person is in is open, as the navigation lists them.
	// Only a channel the person is in has settings for them.
	const selected = selectedChannelId
		? channels?.find((channel) => channel.id === selectedChannelId && channel.isMember)
		: channels?.find((channel) => channel.isMember);

	if (isPending) return null;
	if (error) {
		return (
			<SettingsPage title="Channels">
				<Alert>{failureMessage(error)}</Alert>
			</SettingsPage>
		);
	}
	if (!selected) {
		return (
			<div className="grid min-h-80 flex-1 place-items-center p-6">
				<EmptyState title={selectedChannelId ? "No such channel here" : "No channels yet"}>
					{selectedChannelId
						? "It may have been removed, or you may no longer have access to it."
						: canCreateChannels
							? "Make the first channel for this workspace."
							: "You are not in a channel yet."}
				</EmptyState>
			</div>
		);
	}
	switch (channelPage) {
		case "people":
			return (
				<SettingsPage
					key={selected.id}
					title="People"
					description={`Who is in ${selected.name}.`}
					headerAction={
						selected.permissions.manageMembers && <AddPeopleButton channel={selected} />
					}
				>
					<Members channel={selected} canManageMembers={selected.permissions.manageMembers} />
				</SettingsPage>
			);
		case "bots":
			return <ChannelBots key={selected.id} channel={selected} />;
		case "general":
			return <ChannelDetails key={selected.id} channel={selected} />;
	}
}

function ChannelDetails({ channel }: { channel: Channel }) {
	const may = channel.permissions;
	// Two mutations, so a failed rename is said under the name and a failed recolour above the page.
	const rename = useUpdateChannel(channel.id);
	const recolour = useUpdateChannel(channel.id);
	const members = useChannelMembers(channel.id);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const remove = useDeleteChannel();
	const router = useRouter();
	const { leaveForPage } = useLeave();
	const bots = useChannelBots(channel.id).data ?? [];
	const people = members.data?.length;

	async function deleteChannel() {
		try {
			await remove.mutateAsync(channel.id);
		} catch {
			return;
		}
		// Back to the channels, or the channels in the deleted one's place, so Back never returns to it.
		leaveForPage(
			router.buildLocation(
				linkOptions({
					from: "/$workspace",
					to: "./settings/$section",
					params: { section: "channels" },
				}),
			).href,
		);
	}

	const counts = [
		`${bots.length} ${bots.length === 1 ? "bot" : "bots"}`,
		people !== undefined ? `${people} ${people === 1 ? "person" : "people"}` : undefined,
	].filter(Boolean);

	return (
		<SettingsPage
			hero={<ChannelInitial channel={channel} size="lg" />}
			title={channel.name}
			description={counts.join(", ")}
		>
			{recolour.error && <Alert>{failureMessage(recolour.error)}</Alert>}
			{may.rename && (
				<SettingsGroup label="Channel">
					<SettingsNameRow
						name={channel.name}
						maxLength={CHANNEL_NAME_MAX_LENGTH}
						savePending={rename.isPending}
						error={rename.error ? failureMessage(rename.error) : undefined}
						onCommit={(name) => rename.mutateAsync({ name })}
					/>
					<SettingsNameRow
						label="Description"
						name={channel.description ?? ""}
						maxLength={CHANNEL_DESCRIPTION_MAX_LENGTH}
						optional
						savePending={recolour.isPending}
						onCommit={(description) => recolour.mutateAsync({ description: description || null })}
					/>
					<SettingsRow
						label="Public"
						sub={
							channel.visibility === "public"
								? "Listed for everyone in the workspace to join"
								: "Only people added to it can see it"
						}
						trailing={
							<Toggle
								checked={channel.visibility === "public"}
								disabled={recolour.isPending}
								label={channel.visibility === "public" ? "Make private" : "Make public"}
								onChange={(on) =>
									void recolour
										.mutateAsync({ visibility: on ? "public" : "private" })
										.catch(() => {})
								}
							/>
						}
					/>
				</SettingsGroup>
			)}
			{may.rename && channel.color !== null && (
				<SettingsGroup label="Look" note="Shown on the channel's icon in the sidebar.">
					<SettingsControlRow label="Colour">
						<ChannelColourPicker
							value={channel.color}
							onChange={(color) => void recolour.mutateAsync({ color }).catch(() => {})}
						/>
					</SettingsControlRow>
				</SettingsGroup>
			)}
			{may.delete && (
				<SettingsDanger
					label="Delete channel"
					description="Removes its main chat, threads and files."
					action="Delete"
					onClick={() => setConfirmingDelete(true)}
				/>
			)}
			<DeleteDialog
				open={confirmingDelete}
				onOpenChange={setConfirmingDelete}
				title={`Delete ${channel.name}?`}
				description="Its main chat, threads and files will be deleted. This can't be undone."
				pending={remove.isPending}
				error={remove.error ? failureMessage(remove.error) : undefined}
				onDelete={deleteChannel}
			/>
		</SettingsPage>
	);
}

/**
 * The bots added to the channel, which answer there when mentioned, with
 * adding another public bot and taking one out for whoever may.
 */
function ChannelBots({ channel }: { channel: Channel }) {
	const bots = useChannelBots(channel.id);
	const { bots: workspaceBots } = useBots();
	const place = usePlaceChannelBot(channel.id);
	const backToBots = useBackToHere("Bots");
	const may = channel.permissions.manageBots;
	const inChannel = new Set(bots.data?.map((bot) => bot.id));
	const addable =
		workspaceBots?.filter(
			(bot) =>
				bot.visibility === "public" &&
				bot.systemBotKey === null &&
				!bot.assistant &&
				!inChannel.has(bot.id),
		) ?? [];
	const count = bots.data?.length ?? 0;
	return (
		<SettingsPage
			title="Bots"
			description={`${count} ${count === 1 ? "bot" : "bots"} in ${channel.name}`}
			headerAction={
				may && (
					<DropdownMenu>
						<SettingsAddButton disabled={place.isPending} render={<DropdownMenuTrigger />}>
							Add bot
						</SettingsAddButton>
						<DropdownMenuContent align="end" className="min-w-52">
							{addable.length === 0 ? (
								<DropdownMenuItem disabled>Every public bot is here.</DropdownMenuItem>
							) : (
								addable.map((bot) => (
									<DropdownMenuItem
										key={bot.id}
										onClick={() => place.mutate({ botId: bot.id, added: true })}
									>
										<span aria-hidden>
											<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={22} />
										</span>
										<span className="min-w-0 flex-1 truncate">{bot.name}</span>
									</DropdownMenuItem>
								))
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				)
			}
		>
			{place.error && <Alert>{failureMessage(place.error)}</Alert>}
			<SettingsGroup>
				{count === 0 && (
					<SettingsRow
						label={<span className="text-muted-foreground">No bots in this channel yet</span>}
					/>
				)}
				{bots.data?.map((bot) => (
					<SettingsRow
						key={bot.id}
						icon={<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={24} />}
						// The name opens the bot's settings and Remove sits beside it, so no button is inside a link.
						label={
							<Link
								{...botSettingsLink(bot)}
								state={backToBots}
								className="focus-ring rounded-sm hover:underline"
							>
								{bot.name}
							</Link>
						}
						sub={bot.description || undefined}
						trailing={
							may && (
								<Tooltip label="Remove from channel">
									<button
										type="button"
										aria-label={`Remove ${bot.name}`}
										disabled={place.isPending}
										onClick={() => place.mutate({ botId: bot.id, added: false })}
										className="focus-ring grid size-7 shrink-0 place-items-center rounded-full text-destructive-text transition-colors hover:bg-destructive-hover"
									>
										<Minus size={13} strokeWidth={2.6} />
									</button>
								</Tooltip>
							)
						}
					/>
				))}
			</SettingsGroup>
		</SettingsPage>
	);
}

/**
 * Every bot the person reaches, as the Bots section lists them, with making
 * another. Each opens its own settings.
 */
export function WorkspaceBotsSettings({ canCreate }: { canCreate: boolean }) {
	const { bots: reachable, isPending, error } = useBots();
	const newBot = useNewBot();
	const backToBots = useBackToHere("Bots");
	const bots = reachable?.filter((bot) => bot.systemBotKey === null) ?? [];
	if (isPending) return null;
	return (
		<SettingsPage
			title="Bots"
			description="Public bots everyone can talk to, your private ones, and your Personal Assistant."
			headerAction={
				canCreate &&
				newBot.start && <SettingsAddButton onClick={newBot.start}>New bot</SettingsAddButton>
			}
		>
			{error ? <Alert>{failureMessage(error)}</Alert> : null}
			<SettingsGroup>
				{bots.map((bot) => (
					<SettingsRow
						key={bot.id}
						icon={<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={24} />}
						label={bot.name}
						sub={
							bot.assistant
								? "Your Personal Assistant"
								: bot.visibility === "private"
									? "Private"
									: bot.description || undefined
						}
						chevron
						render={<Link {...botSettingsLink(bot)} state={backToBots} />}
					/>
				))}
			</SettingsGroup>
			{newBot.dialog}
		</SettingsPage>
	);
}

/*
 * The people in the channel. Anyone in the workspace can be added; the label
 * after a name is their standing in the workspace, since a channel has no
 * roles of its own. Administrators are in every channel, so who can be taken
 * out, and whether you may leave, is the API's answer.
 */
function Members({ channel, canManageMembers }: { channel: Channel; canManageMembers: boolean }) {
	const members = useChannelMembers(channel.id);
	const workspaceMembers = useWorkspaceMembers(channel.workspaceId);
	const remove = usePlaceChannelMember(channel.id);
	const leave = useLeaveChannel(channel.id);
	const navigate = useNavigate();
	const [removing, setRemoving] = useState<ChannelMember>();
	const session = useSession();
	const roleOf = (userId: string) =>
		workspaceMembers.data?.find((member) => member.user.id === userId)?.role;
	const isYou = (userId: string) => userId === session.user?.id;
	const mayTakeOut = (member: ChannelMember) =>
		isYou(member.userId) ? channel.permissions.leave : canManageMembers && member.removable;
	const leaving = removing !== undefined && isYou(removing.userId);
	const pending = leaving ? leave : remove;

	async function takeOut(member: ChannelMember) {
		const isLeaving = isYou(member.userId);
		try {
			if (isLeaving) {
				await leave.mutateAsync();
			} else {
				await remove.mutateAsync({ userId: member.userId, member: false });
			}
		} catch {
			return;
		}
		setRemoving(undefined);
		if (isLeaving) {
			await navigate({
				from: "/$workspace",
				to: "./settings/$section",
				params: { section: "channels" },
			});
		}
	}

	let rows: ReactNode;
	if (members.isError) {
		rows = (
			<div className="px-4 py-3">
				<Alert>{failureMessage(members.error)}</Alert>
			</div>
		);
	} else if (members.data?.length === 0) {
		rows = <SettingsRow label="Nobody is in this channel yet" />;
	} else {
		rows = members.data?.map((member) => (
			<SettingsRow
				key={member.userId}
				icon={<PersonAvatar person={member} size={24} />}
				label={member.name}
				trailing={
					<>
						<SettingsValue>
							{isYou(member.userId)
								? "You"
								: // Said once the workspace roster has answered, not guessed before it.
									workspaceMembers.data && workspaceRoleLabel(roleOf(member.userId))}
						</SettingsValue>
						{mayTakeOut(member) && (
							<Tooltip label={isYou(member.userId) ? "Leave channel" : "Remove from channel"}>
								<button
									type="button"
									aria-label={
										isYou(member.userId) ? `Leave ${channel.name}` : `Remove ${member.name}`
									}
									disabled={remove.isPending || leave.isPending}
									onClick={() => setRemoving(member)}
									className="focus-ring grid size-7 shrink-0 place-items-center rounded-full text-destructive-text transition-colors hover:bg-destructive-hover"
								>
									<Minus size={13} strokeWidth={2.6} />
								</button>
							</Tooltip>
						)}
					</>
				}
			/>
		));
	}

	return (
		<SettingsGroup>
			{rows}
			<DeleteDialog
				open={removing !== undefined}
				onOpenChange={(open) => {
					if (!open) setRemoving(undefined);
				}}
				title={
					leaving
						? `Leave ${channel.name}?`
						: `Remove ${removing?.name ?? "this person"} from ${channel.name}?`
				}
				description={
					leaving
						? "You leave its conversations. If it's public, you can join again."
						: "They leave its conversations. You can add them back at any time."
				}
				confirmLabel={leaving ? "Leave" : "Remove"}
				pending={pending.isPending}
				error={pending.error ? failureMessage(pending.error) : undefined}
				onDelete={async () => {
					if (removing) await takeOut(removing);
				}}
			/>
		</SettingsGroup>
	);
}

/**
 * Add people, beside the People title: a menu of the workspace's people who
 * aren't in the channel yet, each added as they are picked. Why an add failed is
 * said under the button.
 */
function AddPeopleButton({ channel }: { channel: Channel }) {
	const members = useChannelMembers(channel.id);
	const workspaceMembers = useWorkspaceMembers(channel.workspaceId);
	const invite = usePlaceChannelMember(channel.id);
	const inChannel = new Set(members.data?.map((member) => member.userId));
	const invitable = workspaceMembers.data?.filter((member) => !inChannel.has(member.user.id)) ?? [];
	return (
		<div className="flex flex-col items-end gap-2">
			<DropdownMenu>
				<SettingsAddButton disabled={invite.isPending} render={<DropdownMenuTrigger />}>
					Add people
				</SettingsAddButton>
				<DropdownMenuContent align="end" className="min-w-52">
					{workspaceMembers.isPending ? (
						<DropdownMenuItem disabled>Loading…</DropdownMenuItem>
					) : invitable.length === 0 ? (
						<DropdownMenuItem disabled>Everyone in the workspace is here.</DropdownMenuItem>
					) : (
						invitable.map((member) => (
							<DropdownMenuItem
								key={member.user.id}
								onClick={() => invite.mutate({ userId: member.user.id, member: true })}
							>
								{/* Hidden from the name, or the initials would read as part of it. */}
								<span aria-hidden>
									<PersonAvatar person={member.user} size={22} />
								</span>
								<span className="min-w-0 flex-1 truncate">{member.user.name}</span>
							</DropdownMenuItem>
						))
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			{invite.error && <Alert>{failureMessage(invite.error)}</Alert>}
		</div>
	);
}
