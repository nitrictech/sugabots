import type { Bot } from "@sugabots/contracts";
import type { ReactNode } from "react";
import { useAutomationActions, useRestrictableAutomations } from "@/lib/automations.ts";
import { useConnectorActions, useRestrictableConnectors } from "@/lib/connectors.ts";
import { failureMessage } from "@/lib/failure.ts";
import { BotCrumb } from "@/shell/BotCrumb.tsx";
import { Page } from "@/shell/Page.tsx";
import { Alert } from "@/ui/alert.tsx";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";

export function BotConnectorRestrictions({ bot }: { bot: Bot }) {
	const connectors = useRestrictableConnectors(bot.defaultProjectId);
	const { update } = useConnectorActions(bot.defaultProjectId);
	return (
		<Restrictions bot={bot} title="Connectors" error={update.error ?? connectors.error}>
			{connectors.data?.map(({ id, name, enabled }) => (
				<SettingsRow
					key={id}
					label={name}
					trailing={
						<Toggle
							label={`Turn off ${name}`}
							checked={enabled}
							disabled={!enabled || update.isPending}
							onChange={() => update.mutate({ connectorId: id, json: { enabled: false } })}
						/>
					}
				/>
			))}
		</Restrictions>
	);
}

export function BotAutomationRestrictions({ bot }: { bot: Bot }) {
	const projectId = bot.defaultProjectId;
	const automations = useRestrictableAutomations(projectId);
	const { update } = useAutomationActions();
	return (
		<Restrictions bot={bot} title="Automations" error={update.error ?? automations.error}>
			{automations.data?.map(({ id, name, state }) => (
				<SettingsRow
					key={id}
					label={name}
					trailing={
						<Toggle
							label={`Pause ${name}`}
							checked={state === "enabled"}
							disabled={state === "paused" || update.isPending}
							onChange={() =>
								update.mutate({ projectId, automationId: id, json: { state: "paused" } })
							}
						/>
					}
				/>
			))}
		</Restrictions>
	);
}

function Restrictions({
	bot,
	title,
	error,
	children,
}: {
	bot: Bot;
	title: string;
	error: unknown;
	children: ReactNode;
}) {
	return (
		<Page title={title} parent={<BotCrumb bot={bot} />} place={{ kind: "owner", owner: { bot } }}>
			<SettingsPage>
				{error != null && <Alert>{failureMessage(error)}</Alert>}
				<SettingsGroup label="Switch off">{children}</SettingsGroup>
			</SettingsPage>
		</Page>
	);
}
