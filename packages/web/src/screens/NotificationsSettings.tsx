import type {
	AutomationRunNotifications,
	NotificationPreferences,
	NotificationSettings,
	QuietHours,
} from "@sugabots/contracts";
import { useId } from "react";
import { useChannels } from "@/lib/channels.ts";
import { failureMessage } from "@/lib/failure.ts";
import {
	DEFAULT_QUIET_HOURS,
	NOTIFICATION_LEVEL_LABELS,
	NOTIFICATION_LEVEL_NOTES,
} from "@/lib/notification-choices.ts";
import {
	formatUntil,
	MUTE_DURATIONS,
	useBrowserNotifications,
	useNotificationSettings,
	useUpdateNotificationPreferences,
} from "@/lib/notifications.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import {
	SettingsChoiceRow,
	SettingsControlRow,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { NotificationLevelPicker } from "./NotificationLevelMenu.tsx";

/** What Sugabots notifies the person about, where, and when not. */
export function NotificationsSettings() {
	const { data: settings, error } = useNotificationSettings();
	return (
		<SettingsPage title="Notifications" description="What Sugabots tells you about, and when.">
			<ThisBrowser />
			{error && <Alert>{failureMessage(error)}</Alert>}
			{settings && (
				<>
					<NotifyAbout settings={settings} />
					<AlsoNotifyAbout settings={settings} />
					<Pause settings={settings} />
					<QuietHoursSettings settings={settings} />
					<ChannelLevels settings={settings} />
				</>
			)}
		</SettingsPage>
	);
}

/** Turning notifications on or off in this browser, and why it can't be when it can't. */
function ThisBrowser() {
	const { status, enable, disable, sendTest } = useBrowserNotifications();
	const failure = enable.error ?? disable.error ?? sendTest.error;
	const on = status.state === "on";

	return (
		<SettingsGroup
			label="This browser"
			note={
				failure
					? failureMessage(failure)
					: status.state === "unsupported"
						? "This browser can't show notifications. On an iPhone or iPad, add Sugabots to your Home Screen and open it from there."
						: status.state === "denied"
							? "Notifications are blocked for Sugabots. Allow them in your browser's settings for this site, then come back."
							: undefined
			}
		>
			<SettingsRow
				label="Notifications"
				sub="Each browser and device is turned on by itself, and notifies you while Sugabots is open in it."
				trailing={
					on || status.state === "off" ? (
						<Toggle
							label="Notifications in this browser"
							checked={on}
							disabled={enable.isPending || disable.isPending}
							onChange={(on) => (on ? enable.mutate() : disable.mutate())}
						/>
					) : (
						<SettingsValue>{status.state === "denied" ? "Blocked" : "Not available"}</SettingsValue>
					)
				}
			/>
			{on && (
				<SettingsRow
					label="Send a test notification"
					trailing={
						<Button
							size="sm"
							variant="secondary"
							disabled={sendTest.isPending}
							onClick={() => sendTest.mutate()}
						>
							{sendTest.isSuccess ? "Sent" : "Send"}
						</Button>
					}
				/>
			)}
		</SettingsGroup>
	);
}

const LEVEL_OPTIONS = (["all", "mentions", "nothing"] as const).map((value) => ({
	value,
	label: NOTIFICATION_LEVEL_LABELS[value],
}));

function preferencesOf(settings: NotificationSettings): NotificationPreferences {
	return {
		level: settings.level,
		pausedUntil: settings.pausedUntil,
		quietHours: settings.quietHours,
		turnFailures: settings.turnFailures,
		automationRuns: settings.automationRuns,
	};
}

function NotifyAbout({ settings }: { settings: NotificationSettings }) {
	const update = useUpdateNotificationPreferences();
	return (
		<SettingsGroup label="Notify me about" note={NOTIFICATION_LEVEL_NOTES[settings.level]}>
			<SettingsChoiceRow
				label="Notify me about"
				options={LEVEL_OPTIONS}
				value={settings.level}
				onChange={(level) => update.mutate({ ...preferencesOf(settings), level })}
			/>
		</SettingsGroup>
	);
}

function Pause({ settings }: { settings: NotificationSettings }) {
	const update = useUpdateNotificationPreferences();
	const pausedUntil = settings.pausedUntil ? new Date(settings.pausedUntil) : null;
	const paused = pausedUntil !== null && pausedUntil > new Date();
	const pauseUntil = (until: Date | null) =>
		update.mutate({ ...preferencesOf(settings), pausedUntil: until?.toISOString() ?? null });

	return (
		<SettingsGroup>
			<SettingsRow
				label="Pause notifications"
				sub={paused ? `Paused until ${formatUntil(pausedUntil)}` : undefined}
				trailing={
					paused ? (
						<Button size="sm" variant="secondary" onClick={() => pauseUntil(null)}>
							Resume
						</Button>
					) : (
						<DropdownMenu>
							<DropdownMenuTrigger render={<Button size="sm" variant="secondary" />}>
								Pause
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="min-w-44">
								{MUTE_DURATIONS.map((pause) => (
									<DropdownMenuItem
										key={pause.label}
										onClick={() => pauseUntil(pause.until(new Date()))}
									>
										{pause.label}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					)
				}
			/>
		</SettingsGroup>
	);
}

const AUTOMATION_RUN_OPTIONS: { value: AutomationRunNotifications; label: string }[] = [
	{ value: "failures", label: "Failed" },
	{ value: "all", label: "Every run" },
	{ value: "none", label: "None" },
];

/** What besides messages the person hears of, unless their level is Nothing. */
function AlsoNotifyAbout({ settings }: { settings: NotificationSettings }) {
	const update = useUpdateNotificationPreferences();
	return (
		<SettingsGroup
			label="Also notify me when"
			note="Runs of automations you made or started. Muting a channel or bot quiets these too."
		>
			<SettingsRow
				label="A bot can't finish its reply to me"
				trailing={
					<Toggle
						label="A bot can't finish its reply to me"
						checked={settings.turnFailures}
						onChange={(turnFailures) => update.mutate({ ...preferencesOf(settings), turnFailures })}
					/>
				}
			/>
			<SettingsChoiceRow
				label="My automations run"
				options={AUTOMATION_RUN_OPTIONS}
				value={settings.automationRuns}
				onChange={(automationRuns) => update.mutate({ ...preferencesOf(settings), automationRuns })}
			/>
		</SettingsGroup>
	);
}

function QuietHoursSettings({ settings }: { settings: NotificationSettings }) {
	const update = useUpdateNotificationPreferences();
	const fromId = useId();
	const toId = useId();
	const quietHours = settings.quietHours;
	const save = (next: QuietHours | null) =>
		update.mutate({ ...preferencesOf(settings), quietHours: next });
	const thisDevicesTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

	return (
		<SettingsGroup
			label="Quiet hours"
			note={
				quietHours
					? `No notifications between these times each day, in ${quietHours.timeZone}.`
					: "Turn off notifications overnight, or whenever you're not working."
			}
		>
			<SettingsRow
				label="Quiet hours"
				trailing={
					<Toggle
						label="Quiet hours"
						checked={quietHours !== null}
						onChange={(on) =>
							save(on ? { ...DEFAULT_QUIET_HOURS, timeZone: thisDevicesTimeZone } : null)
						}
					/>
				}
			/>
			{quietHours && (
				<>
					<SettingsControlRow label="From" htmlFor={fromId}>
						<TimeInput
							id={fromId}
							value={quietHours.from}
							onChange={(from) => save({ ...quietHours, from, timeZone: thisDevicesTimeZone })}
						/>
					</SettingsControlRow>
					<SettingsControlRow label="To" htmlFor={toId}>
						<TimeInput
							id={toId}
							value={quietHours.to}
							onChange={(to) => save({ ...quietHours, to, timeZone: thisDevicesTimeZone })}
						/>
					</SettingsControlRow>
				</>
			)}
		</SettingsGroup>
	);
}

function TimeInput({
	id,
	value,
	onChange,
}: {
	id: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<input
			id={id}
			type="time"
			value={value}
			// A time being typed is empty until it is whole.
			onChange={(event) => event.target.value && onChange(event.target.value)}
			className="ml-auto bg-transparent text-sm text-foreground outline-none"
		/>
	);
}

/** A level for each channel, in place of the person's own, as Slack sets one per channel. */
function ChannelLevels({ settings }: { settings: NotificationSettings }) {
	const { data: channels } = useChannels();
	if (!channels || channels.length === 0) return null;
	return (
		<SettingsGroup
			label="Channels"
			note="A channel or bot set to Default follows what you chose above. Right-click a channel or a bot in the sidebar to change it there."
		>
			{channels.map((channel) => (
				<SettingsRow
					key={channel.id}
					label={channel.name}
					trailing={
						<NotificationLevelPicker
							settings={settings}
							place={{ kind: "channel", id: channel.id }}
							name={channel.name}
						/>
					}
				/>
			))}
		</SettingsGroup>
	);
}
