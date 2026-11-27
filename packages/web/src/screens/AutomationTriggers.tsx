import type { AutomationTrigger, AutomationTriggerInput } from "@sugabots/contracts";
import { type ReactNode, useState } from "react";
import type { TriggerKind } from "@/lib/automation-trigger-words.ts";
import { failureMessage } from "@/lib/failure.ts";
import { ownerName, type ResourceOwner, resourceProjectId } from "@/lib/resource-owner.tsx";
import {
	defaultSchedule,
	type RoutineReading,
	readSchedule,
	scheduleOfReading,
	scheduleReady,
	scheduleSummary,
	triggerLabel,
} from "@/lib/routine-schedule.ts";
import { useSaving } from "@/lib/saving.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import {
	DialogFormBody,
	DialogFormFooter,
	DialogFormFrame,
	DialogFormHeader,
	DialogFormScroll,
	DialogFormStep,
} from "@/ui/dialog-form.tsx";
import { SettingsAddRow, SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";
import {
	NEW_REPOSITORY_TRIGGER,
	PICK_AN_EVENT_NOTE,
	type RepositoryDraft,
	RepositoryGroups,
	repositoryTrigger,
} from "./AutomationRepository.tsx";
import { TriggerKindMark, TriggerKindStep, triggerKindChoice } from "./AutomationTriggerKinds.tsx";
import {
	authNote,
	NEW_WEBHOOK,
	NewWebhookGroups,
	NO_SECRET_NOTE,
	SECRET_TOO_SHORT_NOTE,
	secretReady,
	type WebhookDraft,
} from "./AutomationWebhook.tsx";
import { RoutineGroups } from "./RoutineSchedule.tsx";

/*
 * What starts an automation: its routines, then its other triggers, any number
 * of each, each opening a dialog to change it. Add routine sets one up; Add
 * trigger is a dialog that chooses the kind and then sets it up. An automation
 * with none runs only when someone runs it.
 */

/** The page lists an automation's routines apart from its other triggers. */
export type TriggerSection = "routines" | "triggers";

/** The section that lists a trigger of `kind`. */
function sectionOf(kind: TriggerKind): TriggerSection {
	return kind === "routine" ? "routines" : "triggers";
}

/** Each section's heading, its row while it has none, and its row that adds one. */
const SECTION_WORDS: Record<TriggerSection, { label: string; none: string; add: string }> = {
	routines: { label: "Routines", none: "No routines", add: "Add routine" },
	triggers: { label: "Triggers", none: "No triggers", add: "Add trigger" },
};

/** The note under the empty sections of an automation that nothing starts. */
const RUNS_ONLY_BY_HAND = "It runs only when someone runs it.";

/** A trigger as written in a dialog, before it is saved. */
export type TriggerDraft =
	| { kind: "routine"; reading: RoutineReading; timezone: string }
	| { kind: "webhook"; webhook: WebhookDraft }
	| { kind: "github"; repository: RepositoryDraft };

/** A new trigger of `kind`, as it starts: a daily routine, a webhook taking a bearer token, a repository to pick. */
function newTriggerDraft(kind: TriggerKind): TriggerDraft {
	switch (kind) {
		case "routine":
			return {
				kind: "routine",
				reading: { kind: "picked", schedule: defaultSchedule() },
				timezone: localTimezone(),
			};
		case "webhook":
			return { kind: "webhook", webhook: NEW_WEBHOOK };
		case "github":
			return { kind: "github", repository: NEW_REPOSITORY_TRIGGER };
	}
}

/** `trigger` as a draft to change. A webhook's secret is changed apart from it, so it starts blank. */
export function buildTriggerDraft(trigger: AutomationTriggerInput): TriggerDraft {
	switch (trigger.kind) {
		case "routine":
			return {
				kind: "routine",
				reading: readSchedule(trigger.schedule),
				timezone: trigger.timezone,
			};
		case "webhook":
			return {
				kind: "webhook",
				webhook: {
					auth: trigger.auth ?? NEW_WEBHOOK.auth,
					deliveryIdHeader:
						trigger.deliveryIdHeader === undefined
							? NEW_WEBHOOK.deliveryIdHeader
							: trigger.deliveryIdHeader,
					secret: trigger.secret ?? "",
					filter: trigger.filter ?? [],
				},
			};
		case "github":
			return {
				kind: "github",
				repository: {
					repository: { connectorId: trigger.connectorId, repository: trigger.repository },
					events: trigger.events,
				},
			};
	}
}

/** What `draft` saves as, or why it can't be saved yet. */
export function triggerInputOf(
	draft: TriggerDraft,
): { input: AutomationTriggerInput } | { notReady: string } {
	switch (draft.kind) {
		case "routine":
			return scheduleReady(draft.reading)
				? {
						input: {
							kind: "routine",
							schedule: scheduleOfReading(draft.reading),
							timezone: draft.timezone,
						},
					}
				: { notReady: PICK_A_DAY_NOTE };
		case "webhook": {
			const { auth, deliveryIdHeader, secret, filter } = draft.webhook;
			if (!secretReady(auth, secret)) return { notReady: SECRET_TOO_SHORT_NOTE };
			const trimmed = secret.trim();
			return {
				input: {
					kind: "webhook",
					auth,
					deliveryIdHeader,
					secret: trimmed === "" ? null : trimmed,
					...(filter.length > 0 ? { filter } : {}),
				},
			};
		}
		case "github": {
			const input = repositoryTrigger(draft.repository);
			if (input) return { input };
			return {
				notReady:
					draft.repository.repository === undefined ? PICK_A_REPOSITORY_NOTE : PICK_AN_EVENT_NOTE,
			};
		}
	}
}

/**
 * The note under a routine: when it runs, and in which time zone, the
 * routine's own, since its times are in it.
 */
function routineNote(reading: RoutineReading, timezone: string): string {
	const when =
		reading.kind === "written" ? "on its own timetable" : scheduleSummary(reading.schedule);
	return `Runs ${when}, ${zoneName(timezone)}.`;
}

/**
 * The time zone a routine's times are in: "your time (AEDT)" when it is
 * this browser's, otherwise the zone's city, "Los Angeles time (PDT)", or
 * its name alone where that is its abbreviation too, "UTC".
 */
function zoneName(timezone: string): string {
	const abbreviation = new Intl.DateTimeFormat(undefined, {
		timeZone: timezone,
		timeZoneName: "short",
	})
		.formatToParts(new Date())
		.find((part) => part.type === "timeZoneName")?.value;
	if (timezone === localTimezone())
		return abbreviation ? `your time (${abbreviation})` : "your time";
	const city = (timezone.split("/").pop() ?? timezone).replaceAll("_", " ");
	if (!abbreviation || abbreviation === city) return city;
	return `${city} time (${abbreviation})`;
}

const PICK_A_DAY_NOTE = "Pick at least one day for it to run on.";
const PICK_A_REPOSITORY_NOTE = "Pick the repository it runs on.";

function localTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** One trigger as the list shows it, by a key the list's owner gives it. */
interface ListedTrigger {
	readonly key: string;
	readonly trigger: AutomationTriggerInput | AutomationTrigger;
}

/**
 * An automation's routines, or its other triggers, each opening it to change,
 * then a row adding one, for someone who may change them.
 */
export function TriggersGroup({
	section,
	triggers,
	editable,
	onOpen,
	onAdd,
	headingLevel,
}: {
	section: TriggerSection;
	/** Every trigger of the automation; the group lists those of its section. */
	triggers: readonly ListedTrigger[];
	editable: boolean;
	onOpen: (key: string) => void;
	onAdd: () => void;
	/** 2 straight under the screen's heading, as on an automation's own page; 3 under a page's title. */
	headingLevel?: 2 | 3;
}) {
	const words = SECTION_WORDS[section];
	const listed = triggers.filter(({ trigger }) => sectionOf(trigger.kind) === section);
	return (
		<SettingsGroup label={words.label} headingLevel={headingLevel}>
			{listed.length === 0 && (
				<SettingsRow
					label={words.none}
					sub={section === "triggers" && triggers.length === 0 ? RUNS_ONLY_BY_HAND : undefined}
				/>
			)}
			{listed.map(({ key, trigger }) => {
				const choice = triggerKindChoice(trigger.kind);
				return (
					<SettingsRow
						key={key}
						icon={<TriggerKindMark choice={choice} />}
						label={triggerLabel(trigger)}
						sub={choice.label}
						chevron={editable}
						onClick={editable ? () => onOpen(key) : undefined}
					/>
				);
			})}
			{editable && <SettingsAddRow label={words.add} onClick={onAdd} />}
		</SettingsGroup>
	);
}

/**
 * Adding a routine; adding another trigger, a step at a time: its kind, then
 * setting it up; or changing one, straight at the second step, with Remove. `onSave` is given
 * what the draft saves as; the dialog closes once it resolves, and shows why
 * when it fails. `settings` replaces the step's groups for a kind whose
 * existing trigger is changed on its own, such as a webhook's address and
 * secret, which save as they change.
 */
export function TriggerDialog({
	owner,
	editing,
	adding,
	settings,
	onSave,
	onRemove,
	done,
}: {
	/** The bot or project; its connectors decide which connectors' triggers it may have. */
	owner: ResourceOwner;
	/** The trigger being changed, as a draft; undefined while adding one. */
	editing: TriggerDraft | undefined;
	/** The section a new trigger is added to, while adding one. */
	adding?: TriggerSection;
	settings?: ReactNode;
	onSave: (input: AutomationTriggerInput) => Promise<unknown> | undefined;
	onRemove?: () => Promise<unknown> | undefined;
	done: () => void;
}) {
	const [draft, setDraft] = useState(
		editing ?? (adding === "routines" ? newTriggerDraft("routine") : undefined),
	);
	const [filterEditing, setFilterEditing] = useState(false);
	const { pending, failure, save } = useSaving();

	/** Runs `action`, then closes the dialog; a failure keeps it open, saying why. */
	async function settle(action: () => Promise<unknown> | undefined) {
		if (await save(action)) done();
	}

	if (!draft) {
		return (
			<DialogFormFrame>
				<TriggerKindStep
					owner={owner}
					onChoose={(kind) => setDraft(newTriggerDraft(kind))}
					done={done}
				/>
			</DialogFormFrame>
		);
	}
	const choice = triggerKindChoice(draft.kind);
	const written = triggerInputOf(draft);
	const saving = settings === undefined;
	return (
		<DialogFormFrame>
			<DialogFormStep
				onSubmit={(event) => {
					event.preventDefault();
					if (saving && !filterEditing && "input" in written)
						void settle(() => onSave(written.input));
					else if (!saving) done();
				}}
			>
				<DialogFormHeader
					title={choice.label}
					onBack={
						editing || adding === "routines"
							? undefined
							: () => {
									setDraft(undefined);
									setFilterEditing(false);
								}
					}
					backDisabled={pending}
				/>
				<DialogFormBody>
					<DialogFormScroll height="picker-tall">
						{settings ?? (
							<DraftGroups
								owner={owner}
								draft={draft}
								onChange={setDraft}
								onFilterEditingChange={setFilterEditing}
							/>
						)}
					</DialogFormScroll>
					{failure !== undefined && <Alert>{failureMessage(failure)}</Alert>}
				</DialogFormBody>
				<DialogFormFooter
					beside={
						onRemove && (
							<Button
								type="button"
								variant="secondary"
								className="mr-auto"
								disabled={pending}
								onClick={() => void settle(onRemove)}
							>
								Remove
							</Button>
						)
					}
					onCancel={saving ? done : undefined}
					cancel={saving}
					cancelDisabled={pending}
					action={saving ? (editing ? "Save" : SECTION_WORDS[sectionOf(draft.kind)].add) : "Done"}
					actionDisabled={pending || (saving && (filterEditing || !("input" in written)))}
				/>
			</DialogFormStep>
		</DialogFormFrame>
	);
}

/** The groups that set up a draft of its kind, under what it still needs or what it does. */
function DraftGroups({
	owner,
	draft,
	onChange,
	onFilterEditingChange,
}: {
	owner: ResourceOwner;
	draft: TriggerDraft;
	onChange: (draft: TriggerDraft) => void;
	onFilterEditingChange: (editing: boolean) => void;
}) {
	const written = triggerInputOf(draft);
	const notReady = "notReady" in written ? written.notReady : undefined;
	switch (draft.kind) {
		case "routine":
			return (
				<RoutineGroups
					reading={draft.reading}
					note={notReady ?? routineNote(draft.reading, draft.timezone)}
					onChange={(schedule) => onChange({ ...draft, reading: { kind: "picked", schedule } })}
				/>
			);
		case "webhook":
			return (
				<NewWebhookGroups
					draft={draft.webhook}
					onFilterEditingChange={onFilterEditingChange}
					note={
						notReady ??
						(draft.webhook.secret.trim() === "" ? NO_SECRET_NOTE : authNote(draft.webhook.auth))
					}
					onChange={(webhook) => onChange({ ...draft, webhook })}
				/>
			);
		case "github":
			return (
				<RepositoryGroups
					projectId={resourceProjectId(owner)}
					ownerName={ownerName(owner)}
					draft={draft.repository}
					onChange={(repository) => onChange({ ...draft, repository })}
				/>
			);
	}
}
