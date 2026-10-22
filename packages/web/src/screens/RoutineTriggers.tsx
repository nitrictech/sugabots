import type { RoutineTrigger, RoutineTriggerInput } from "@sugabots/contracts";
import { type ReactNode, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import {
	defaultSchedule,
	readSchedule,
	type ScheduleReading,
	scheduleOfReading,
	scheduleReady,
	scheduleSummary,
	triggerLabel,
} from "@/lib/routine-schedule.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import {
	DialogFormBody,
	DialogFormFooter,
	DialogFormFrame,
	DialogFormHeader,
	DialogFormStep,
} from "@/ui/dialog-form.tsx";
import { SettingsAddRow, SettingsGroup, SettingsRow } from "@/ui/settings-page.tsx";
import { ScheduleGroups } from "./RoutineSchedule.tsx";
import {
	type TriggerKind,
	TriggerKindMark,
	TriggerKindStep,
	triggerKindChoice,
} from "./RoutineTriggerKinds.tsx";
import {
	authNote,
	NEW_WEBHOOK,
	NewWebhookGroups,
	NO_SECRET_NOTE,
	SECRET_TOO_SHORT_NOTE,
	secretReady,
	type WebhookDraft,
} from "./RoutineWebhook.tsx";

/*
 * What starts a routine: a list of its triggers, any number of any kinds,
 * each opening a dialog to change it, and Add trigger, a dialog that chooses
 * the kind and then sets it up. A routine with none runs only when someone
 * runs it.
 */

/** A trigger as written in a dialog, before it is saved. */
export type TriggerDraft =
	| { kind: "cron"; reading: ScheduleReading; timezone: string }
	| { kind: "webhook"; webhook: WebhookDraft };

/** A new trigger of `kind`, as it starts: a daily schedule, or a webhook taking a bearer token. */
export function newTriggerDraft(kind: TriggerKind): TriggerDraft {
	switch (kind) {
		case "cron":
			return {
				kind: "cron",
				reading: { kind: "picked", schedule: defaultSchedule() },
				timezone: localTimezone(),
			};
		case "webhook":
			return { kind: "webhook", webhook: NEW_WEBHOOK };
	}
}

/** `trigger` as a draft to change. A webhook's secret is changed apart from it, so it starts blank. */
export function triggerDraftOf(trigger: RoutineTriggerInput): TriggerDraft {
	switch (trigger.kind) {
		case "cron":
			return { kind: "cron", reading: readSchedule(trigger.schedule), timezone: trigger.timezone };
		case "webhook":
			return {
				kind: "webhook",
				webhook: { auth: trigger.auth ?? NEW_WEBHOOK.auth, secret: trigger.secret ?? "" },
			};
	}
}

/** What `draft` saves as, or why it can't be saved yet. */
export function triggerInputOf(
	draft: TriggerDraft,
): { input: RoutineTriggerInput } | { notReady: string } {
	switch (draft.kind) {
		case "cron":
			return scheduleReady(draft.reading)
				? {
						input: {
							kind: "cron",
							schedule: scheduleOfReading(draft.reading),
							timezone: draft.timezone,
						},
					}
				: { notReady: PICK_A_DAY_NOTE };
		case "webhook": {
			const { auth, secret } = draft.webhook;
			if (!secretReady(auth, secret)) return { notReady: SECRET_TOO_SHORT_NOTE };
			const trimmed = secret.trim();
			return { input: { kind: "webhook", auth, secret: trimmed === "" ? null : trimmed } };
		}
	}
}

/**
 * The note under a schedule: when it runs, and in which time zone, the
 * schedule's own, since its times are in it.
 */
export function scheduleNote(reading: ScheduleReading, timezone: string): string {
	const when =
		reading.kind === "written" ? "on its own schedule" : scheduleSummary(reading.schedule);
	return `Runs ${when}, ${zoneName(timezone)}.`;
}

/**
 * The time zone a schedule's times are in: "your time (AEDT)" when it is
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

export function localTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** One trigger as the list shows it, by a key the list's owner gives it. */
export interface ListedTrigger {
	readonly key: string;
	readonly trigger: RoutineTriggerInput | RoutineTrigger;
}

/** A routine's triggers, each opening it to change, then Add trigger, for someone who may change them. */
export function TriggersGroup({
	triggers,
	editable,
	note,
	onOpen,
	onAdd,
}: {
	triggers: readonly ListedTrigger[];
	editable: boolean;
	note?: ReactNode;
	onOpen: (key: string) => void;
	onAdd: () => void;
}) {
	return (
		<SettingsGroup label="Triggers" note={note}>
			{triggers.length === 0 && (
				<SettingsRow label="No triggers" sub="It runs only when someone runs it." />
			)}
			{triggers.map(({ key, trigger }) => {
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
			{editable && <SettingsAddRow label="Add trigger" onClick={onAdd} />}
		</SettingsGroup>
	);
}

/**
 * Adding a trigger, a step at a time: its kind, then setting it up; or
 * changing one, straight at the second step, with Remove. `onSave` is given
 * what the draft saves as; the dialog closes once it resolves, and shows why
 * when it fails. `settings` replaces the step's groups for a kind whose
 * existing trigger is changed on its own, such as a webhook's address and
 * secret, which save as they change.
 */
export function TriggerDialog({
	editing,
	settings,
	onSave,
	onRemove,
	done,
}: {
	/** The trigger being changed, as a draft; undefined while adding one. */
	editing: TriggerDraft | undefined;
	settings?: ReactNode;
	onSave: (input: RoutineTriggerInput) => Promise<unknown> | undefined;
	onRemove?: () => Promise<unknown> | undefined;
	done: () => void;
}) {
	const [draft, setDraft] = useState(editing);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<unknown>();

	async function settle(action: () => Promise<unknown> | undefined) {
		setPending(true);
		setError(undefined);
		try {
			await action();
			done();
		} catch (cause) {
			setError(cause);
			setPending(false);
		}
	}

	if (!draft) {
		return (
			<DialogFormFrame>
				<TriggerKindStep onChoose={(kind) => setDraft(newTriggerDraft(kind))} done={done} />
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
					if (saving && "input" in written) void settle(() => onSave(written.input));
					else if (!saving) done();
				}}
			>
				<DialogFormHeader
					title={choice.label}
					onBack={editing ? undefined : () => setDraft(undefined)}
					backDisabled={pending}
				/>
				<DialogFormBody>
					<div className="-mx-1 flex max-h-[min(560px,65vh)] flex-col gap-5 overflow-y-auto px-1">
						{settings ?? <DraftGroups draft={draft} onChange={setDraft} />}
					</div>
					{error !== undefined && <Alert>{failureMessage(error)}</Alert>}
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
					action={saving ? (editing ? "Save" : "Add trigger") : "Done"}
					actionDisabled={pending || (saving && !("input" in written))}
				/>
			</DialogFormStep>
		</DialogFormFrame>
	);
}

/** The groups that set up a draft of its kind, under what it still needs or what it does. */
function DraftGroups({
	draft,
	onChange,
}: {
	draft: TriggerDraft;
	onChange: (draft: TriggerDraft) => void;
}) {
	const written = triggerInputOf(draft);
	const notReady = "notReady" in written ? written.notReady : undefined;
	switch (draft.kind) {
		case "cron":
			return (
				<ScheduleGroups
					reading={draft.reading}
					note={notReady ?? scheduleNote(draft.reading, draft.timezone)}
					onChange={(schedule) => onChange({ ...draft, reading: { kind: "picked", schedule } })}
				/>
			);
		case "webhook":
			return (
				<NewWebhookGroups
					draft={draft.webhook}
					note={
						notReady ??
						(draft.webhook.secret.trim() === "" ? NO_SECRET_NOTE : authNote(draft.webhook.auth))
					}
					onChange={(webhook) => onChange({ ...draft, webhook })}
				/>
			);
	}
}
