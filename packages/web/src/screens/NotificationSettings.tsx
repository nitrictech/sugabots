import {
	type NotificationDelivery,
	type NotificationKind,
	notificationKinds,
} from "@sugabots/contracts";
import type { ReactNode } from "react";
import { type DesktopPermission, useDesktopPermission } from "@/lib/desktop-notifications.ts";
import { failureMessage } from "@/lib/failure.ts";
import {
	useNotificationPreferences,
	useUpdateNotificationDelivery,
	useUpdateNotificationPreference,
} from "@/lib/notifications.ts";
import { Alert } from "@/ui/alert.tsx";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";

const kinds = Object.entries(notificationKinds) as Array<
	[NotificationKind, (typeof notificationKinds)[NotificationKind]]
>;

/** What the signed-in person wants to be told about, and how. */
export function NotificationSettings() {
	const preferences = useNotificationPreferences();
	const updateKind = useUpdateNotificationPreference();
	const updateDelivery = useUpdateNotificationDelivery();
	const failedSave = updateKind.error ?? updateDelivery.error;

	return (
		<SettingsPage title="Notifications" description="Choose what is worth interrupting you for.">
			{preferences.isError ? (
				<Alert>{failureMessage(preferences.error)}</Alert>
			) : (
				preferences.data && (
					<>
						<SettingsGroup label="Tell me when">
							{kinds.map(([kind, { label }]) => (
								<SettingsRow
									key={kind}
									label={label}
									trailing={
										<Toggle
											checked={preferences.data.kinds[kind]}
											label={label}
											onChange={(enabled) => updateKind.mutate({ kind, enabled })}
										/>
									}
								/>
							))}
						</SettingsGroup>
						<DeliveryGroup
							delivery={preferences.data.delivery}
							onChange={(change) => updateDelivery.mutate(change)}
						/>
					</>
				)
			)}
			{failedSave && <Alert>{failureMessage(failedSave)}</Alert>}
		</SettingsPage>
	);
}

function DeliveryGroup({
	delivery,
	onChange,
}: {
	delivery: NotificationDelivery;
	onChange: (change: Partial<NotificationDelivery>) => void;
}) {
	const desktop = useDesktopPermission();

	return (
		<SettingsGroup label="Delivery">
			<SettingsRow
				label="Desktop notifications"
				sub={
					delivery.desktop
						? desktopPermissionNote(desktop.permission, () => void desktop.request())
						: undefined
				}
				trailing={
					<Toggle
						checked={delivery.desktop}
						label="Desktop notifications"
						onChange={(enabled) => {
							// Asked straight from the click, as browsers only ask from one.
							if (enabled) void desktop.request();
							onChange({ desktop: enabled });
						}}
					/>
				}
			/>
			<SettingsRow
				label="Quiet on weekends"
				trailing={
					<Toggle
						checked={delivery.quietOnWeekends}
						label="Quiet on weekends"
						onChange={(quietOnWeekends) => onChange({ quietOnWeekends })}
					/>
				}
			/>
		</SettingsGroup>
	);
}

/**
 * Why desktop notices that are turned on will not show, with the way to let
 * them when there is one, or undefined when they will.
 */
function desktopPermissionNote(permission: DesktopPermission, onAllow: () => void): ReactNode {
	switch (permission) {
		case "granted":
			return undefined;
		case "default":
			return (
				<button
					type="button"
					onClick={onAllow}
					className="focus-ring rounded-sm font-medium text-link"
				>
					Allow in this browser
				</button>
			);
		case "denied":
			return "Blocked in this browser's settings";
		case "unsupported":
			return "This browser can't show them.";
	}
}
