import { ArrowUpRight } from "lucide-react";
import {
	TRIGGER_KINDS,
	type TriggerKind,
	type TriggerKindChoice,
} from "@/lib/automation-trigger-words.ts";
import { useConnectors } from "@/lib/connectors.ts";
import {
	ownerLink,
	ownerName,
	type ResourceOwner,
	resourceProjectId,
} from "@/lib/resource-owner.tsx";
import { ConnectorMark } from "@/ui/connector-mark.tsx";
import {
	DialogFormBody,
	DialogFormHeader,
	DialogFormScroll,
	DialogFormStep,
} from "@/ui/dialog-form.tsx";
import { SearchField, useSearchFilter } from "@/ui/search-field.tsx";
import { SettingsGroup, SettingsRow, SettingsRowIcon } from "@/ui/settings-page.tsx";
import { AutomationTriggerIcon } from "./AutomationTriggerIcon.tsx";

/*
 * The kinds of trigger an automation may have: Sugabots' own, and those of the
 * connectors its project has. There may be many, so the first
 * step of adding one is a searchable list of only those the project can use.
 * Routines are added from their own section, so the list leaves them out.
 */

export function triggerKindChoice(kind: TriggerKind): TriggerKindChoice {
	const found = TRIGGER_KINDS.find((choice) => choice.kind === kind);
	if (!found) throw new Error(`No such kind of trigger: ${kind}`);
	return found;
}

/** A kind of trigger's mark: its connector's mark, or an icon for Sugabots' own. */
export function TriggerKindMark({ choice }: { choice: TriggerKindChoice }) {
	if (choice.connector) {
		return <ConnectorMark markId={choice.connector} name={choice.label} size="tile" />;
	}
	return (
		<SettingsRowIcon className="size-8.5 rounded-lg">
			<AutomationTriggerIcon kind={choice.kind} size={15} strokeWidth={2.2} />
		</SettingsRowIcon>
	);
}

/**
 * The first step of adding a trigger: choosing its kind, found by typing part
 * of its name, from Sugabots' own and those of the connectors `owner` has,
 * with a way to add more.
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
	const connectors = useConnectors(resourceProjectId(owner));
	const connected = new Set(connectors.data?.map((one) => one.kind));
	const { query, setQuery, searching, matches } = useSearchFilter(TRIGGER_KINDS, (choice) => [
		choice.label,
		choice.sub,
	]);
	const own = matches.filter((choice) => !choice.connector && choice.kind !== "routine");
	const connectorTriggers = matches.filter(
		(choice) => choice.connector && connected.has(choice.connector),
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
				<DialogFormScroll height="picker">
					{own.length > 0 && <SettingsGroup label="Built in">{own.map(row)}</SettingsGroup>}
					<SettingsGroup
						label={"bot" in owner ? "From this bot's connectors" : "From this project's connectors"}
					>
						{connectorTriggers.map(row)}
						<SettingsRow
							label={
								connectorTriggers.length > 0
									? "Add another connector"
									: !searching
										? "No connectors with triggers yet"
										: `No connector matches “${query.trim()}”`
							}
							sub={
								connectorTriggers.length > 0
									? `On ${ownerName(owner)}'s Connectors page`
									: `Add a connector on ${ownerName(owner)}'s Connectors page`
							}
							trailing={
								<ArrowUpRight aria-hidden size={15} className="shrink-0 text-subtle-foreground" />
							}
							render={ownerLink(owner, { page: "connectors" })}
						/>
					</SettingsGroup>
				</DialogFormScroll>
			</DialogFormBody>
		</DialogFormStep>
	);
}
