import { ArrowUpRight } from "lucide-react";
import {
	TRIGGER_KINDS,
	type TriggerKind,
	type TriggerKindChoice,
} from "@/lib/automation-trigger-words.ts";
import { useConnections } from "@/lib/connections.ts";
import {
	ownerLink,
	ownerName,
	type ResourceOwner,
	resourceProjectId,
} from "@/lib/resource-owner.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { DialogFormBody, DialogFormHeader, DialogFormStep } from "@/ui/dialog-form.tsx";
import { SearchField, useSearchFilter } from "@/ui/search-field.tsx";
import { SettingsGroup, SettingsRow, SettingsRowIcon } from "@/ui/settings-page.tsx";
import { AutomationTriggerIcon } from "./RunRow.tsx";

/*
 * The kinds of trigger an automation may have: Sugabots' own, and those of the
 * integrations its project is connected to. There may be many, so the first
 * step of adding one is a searchable list of only those the project can use.
 * Routines are added from their own section, so the list leaves them out.
 */

export function triggerKindChoice(kind: TriggerKind): TriggerKindChoice {
	const found = TRIGGER_KINDS.find((choice) => choice.kind === kind);
	if (!found) throw new Error(`No such kind of trigger: ${kind}`);
	return found;
}

/** A kind of trigger's mark: its integration's logo, or an icon for Sugabots' own. */
export function TriggerKindMark({ choice }: { choice: TriggerKindChoice }) {
	if (choice.connection) {
		return <ConnectionMark presetId={choice.connection} name={choice.label} size="tile" />;
	}
	return (
		<SettingsRowIcon className="size-8.5 rounded-lg">
			<AutomationTriggerIcon kind={choice.kind} size={15} strokeWidth={2.2} />
		</SettingsRowIcon>
	);
}

/**
 * The first step of adding a trigger: choosing its kind, found by typing part
 * of its name, from Sugabots' own and those of the integrations `owner` is
 * connected to, with a way to connect it to more.
 */
export function TriggerKindStep({
	owner,
	onChoose,
	done,
}: {
	owner: ResourceOwner;
	onChoose: (kind: TriggerKind) => void;
	done: () => void;
}) {
	const connections = useConnections(resourceProjectId(owner));
	const connected = new Set(connections.data?.map((one) => one.kind));
	const { query, setQuery, searching, matches } = useSearchFilter(TRIGGER_KINDS, (choice) => [
		choice.label,
		choice.sub,
	]);
	const own = matches.filter((choice) => !choice.connection && choice.kind !== "routine");
	const integrations = matches.filter(
		(choice) => choice.connection && connected.has(choice.connection),
	);
	const row = (choice: TriggerKindChoice) => (
		<SettingsRow
			key={choice.kind}
			icon={<TriggerKindMark choice={choice} />}
			label={choice.label}
			sub={choice.sub}
			chevron
			onClick={() => onChoose(choice.kind)}
		/>
	);
	return (
		<DialogFormStep onSubmit={(event) => event.preventDefault()}>
			<DialogFormHeader title="Add a trigger" onClose={done} />
			<DialogFormBody>
				<SearchField label="Search triggers" value={query} onChange={setQuery} />
				<div className="-mx-1 flex max-h-picker flex-col gap-5 overflow-y-auto px-1 max-md:max-h-none max-md:overflow-visible">
					{own.length > 0 && <SettingsGroup label="Built in">{own.map(row)}</SettingsGroup>}
					<SettingsGroup
						label={
							"bot" in owner ? "From this bot's connections" : "From this project's connections"
						}
					>
						{integrations.map(row)}
						{/* Set as the kinds above are, a name and a line under it, so the dialog keeps to their two styles. */}
						<SettingsRow
							label={
								integrations.length > 0
									? "Connect another app"
									: !searching
										? "No connections with triggers yet"
										: `No connection matches “${query.trim()}”`
							}
							sub={
								integrations.length > 0
									? `In ${ownerName(owner)}'s settings`
									: `Connect an app in ${ownerName(owner)}'s settings`
							}
							trailing={
								<ArrowUpRight aria-hidden size={15} className="shrink-0 text-subtle-foreground" />
							}
							render={ownerLink(owner, { page: "connections" })}
						/>
					</SettingsGroup>
				</div>
			</DialogFormBody>
		</DialogFormStep>
	);
}
