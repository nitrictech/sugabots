import { type NotificationKind, notificationKinds } from "@sugabots/contracts";
import { failureMessage } from "@/lib/failure.ts";
import {
	useNotificationPreferences,
	useUpdateNotificationPreference,
} from "@/lib/notifications.ts";
import { Alert } from "@/ui/alert.tsx";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";

const kinds = Object.entries(notificationKinds) as Array<
	[NotificationKind, (typeof notificationKinds)[NotificationKind]]
>;

/** What the signed-in person wants to be told about. */
export function NotificationSettings() {
	const preferences = useNotificationPreferences();
	const update = useUpdateNotificationPreference();

	return (
		<SettingsPage title="Notifications" description="Choose what is worth interrupting you for.">
			{preferences.isError ? (
				<Alert>{failureMessage(preferences.error)}</Alert>
			) : (
				preferences.data && (
					<SettingsGroup label="Tell me when">
						{kinds.map(([kind, { label }]) => (
							<SettingsRow
								key={kind}
								label={label}
								trailing={
									<Toggle
										checked={preferences.data[kind]}
										label={label}
										onChange={(enabled) => update.mutate({ kind, enabled })}
									/>
								}
							/>
						))}
					</SettingsGroup>
				)
			)}
			{update.isError && <Alert>{failureMessage(update.error)}</Alert>}
		</SettingsPage>
	);
}
