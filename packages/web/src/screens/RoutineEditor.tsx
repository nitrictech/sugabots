import {
	type Agent,
	type CalendarSchedule,
	MAX_ROUTINE_INSTRUCTIONS_CHARACTERS,
	MAX_ROUTINE_NAME_CHARACTERS,
	MIN_WEBHOOK_SECRET_CHARACTERS,
	type NewRoutine,
	type Pod,
	type Routine,
	type RoutineResults,
	type RoutineUpdate,
	type WebhookAuth,
} from "@sugabots/contracts";
import { cn } from "cn";
import { Check, ChevronRight, Copy, Play } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import {
	defaultSchedule,
	readSchedule,
	type ScheduleReading,
	scheduleOfReading,
	scheduleReady,
	scheduleSummary,
} from "@/lib/routine-schedule.ts";
import { useRoutineActions } from "@/lib/routines.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import {
	PageBackLink,
	SettingsChoiceRow,
	SettingsControlRow,
	SettingsDanger,
	SettingsFieldLabel,
	SettingsGroup,
	SettingsNameRow,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { RecentRuns } from "./RoutineRuns.tsx";
import { ScheduleRows } from "./RoutineSchedule.tsx";
import {
	authNote,
	DEFAULT_WEBHOOK_AUTH,
	NEW_WEBHOOK,
	NewWebhookRows,
	pastedSecretReady,
	type WebhookDraft,
	WebhookRows,
} from "./RoutineWebhook.tsx";

/** A bot a routine can belong to, with the pod it lives in. */
export interface BotChoice {
	agent: Agent;
	pod: Pod;
}

/** A routine with the bot it belongs to and that bot's pod. */
export interface PlacedRoutine extends BotChoice {
	routine: Routine;
}

/** How far − and + move the time. */

/**
 * How long a schedule rests before it saves, so stepping the time through
 * several half hours saves once, where it stops.
 */
const SCHEDULE_SAVE_DELAY_MS = 600;

/** How long Run now says Starting… at least, so a quick start doesn't flash past unread. */
const STARTING_SHOWN_MS = 1000;

const TRIGGER_OPTIONS = [
	{ value: "cron", label: "Schedule" },
	{ value: "webhook", label: "Webhook" },
] as const;

type TriggerKind = (typeof TRIGGER_OPTIONS)[number]["value"];

/**
 * Where a new routine's result goes until someone chooses: a schedule is
 * usually something to read, such as a morning standup, and a webhook is
 * usually work handled out of sight.
 */
const DEFAULT_RESULTS: Record<TriggerKind, RoutineResults> = {
	cron: "post_to_chat",
	webhook: "keep_in_run",
};

/**
 * A routine being made. Nothing is saved until Create, which opens the new
 * routine's own page; a webhook's secret is made then, and shown there.
 */
export function NewRoutinePage({
	choices,
	initialAgentId,
	onCancel,
	onCreated,
}: {
	/** The bots it may be made for, in the order the picker lists them. */
	choices: readonly BotChoice[];
	/** The bot it starts on, when it was begun from that bot's settings. */
	initialAgentId: string | undefined;
	onCancel: () => void;
	onCreated: (routine: Routine) => void;
}) {
	const [name, setName] = useState("");
	const [instructions, setInstructions] = useState("");
	const [agentId, setAgentId] = useState(
		choices.find((choice) => choice.agent.id === initialAgentId)?.agent.id ?? choices[0]?.agent.id,
	);
	const [kind, setKind] = useState<TriggerKind>("cron");
	// Unset until chosen, so the result follows the trigger's default.
	const [chosenResults, setChosenResults] = useState<RoutineResults>();
	const [reading, setReading] = useState<ScheduleReading>(() => ({
		kind: "picked",
		schedule: defaultSchedule(),
	}));
	const [webhook, setWebhook] = useState(NEW_WEBHOOK);
	const [page, setPage] = useState<"routine" | "instructions">("routine");
	const actions = useRoutineActions();
	const bot = choices.find((choice) => choice.agent.id === agentId);
	const results = chosenResults ?? DEFAULT_RESULTS[kind];
	const daysReady = kind === "webhook" || scheduleReady(reading);
	const secretReady = kind === "cron" || pastedSecretReady(webhook.secret);
	const ready =
		bot !== undefined &&
		name.trim() !== "" &&
		instructions.trim() !== "" &&
		daysReady &&
		secretReady;

	async function create() {
		if (!bot || !ready) return;
		const fields = { name, instructions, results };
		const input: NewRoutine =
			kind === "cron"
				? {
						...fields,
						trigger: {
							kind: "cron",
							schedule: scheduleOfReading(reading),
							timezone: localTimezone(),
						},
					}
				: { ...fields, trigger: webhookTrigger(webhook) };
		try {
			const created = await actions.create.mutateAsync({ agentId: bot.agent.id, json: input });
			onCreated(created.routine);
		} catch {
			// The page shows the error.
		}
	}

	if (page === "instructions") {
		const back = () => setPage("routine");
		return (
			<InstructionsPage
				back={
					<PageBackLink
						label={name.trim() || "New routine"}
						render={<button type="button" onClick={back} />}
					/>
				}
				botName={bot?.agent.name}
				value={instructions}
				onChange={setInstructions}
				editable
				action={<Button onClick={back}>Done</Button>}
			/>
		);
	}
	return (
		<SettingsPage
			title={name.trim() || "New routine"}
			description="Set it up, then create it."
			headerAction={
				<div className="flex gap-2">
					<Button variant="secondary" onClick={onCancel} disabled={actions.create.isPending}>
						Cancel
					</Button>
					<Button onClick={() => void create()} disabled={!ready || actions.create.isPending}>
						Create routine
					</Button>
				</div>
			}
		>
			{actions.create.error && <Alert>{failureMessage(actions.create.error)}</Alert>}
			<SettingsGroup>
				<NameInputRow value={name} onChange={setName} />
				<BotRow chosen={bot} choices={choices} onChoose={setAgentId} />
				<InstructionsRow
					value={instructions.trim() === "" ? "Add" : "Edit"}
					onOpen={() => setPage("instructions")}
				/>
			</SettingsGroup>
			<SettingsGroup
				label="When"
				note={
					bot &&
					(!daysReady
						? "Pick at least one day for it to run on."
						: !secretReady
							? `A pasted secret needs at least ${MIN_WEBHOOK_SECRET_CHARACTERS} characters.`
							: whenNote({
									trigger: kind === "cron" ? { kind } : { kind, auth: webhook.auth },
									reading,
									timezone: localTimezone(),
									results,
									bot,
								}))
				}
			>
				<TriggerRow value={kind} onChange={setKind} />
				{kind === "cron" ? (
					<ScheduleRows
						reading={reading}
						onChange={(schedule) => setReading({ kind: "picked", schedule })}
					/>
				) : (
					<NewWebhookRows draft={webhook} onChange={setWebhook} />
				)}
			</SettingsGroup>
			<SettingsGroup>
				<ResultsRow results={results} onChange={setChosenResults} />
			</SettingsGroup>
		</SettingsPage>
	);
}

/**
 * An existing routine, which saves each change as it is made, as the rest of
 * settings does: a field when you leave it, a choice when you make it, and a
 * schedule once it rests. It stays with the bot it was made for, since the
 * API addresses it through that bot. Somebody who may not manage its bot's
 * routines sees it without being able to change it.
 */
export function RoutinePage({
	placed,
	siblingNames,
	onDuplicated,
	onDeleted,
}: {
	placed: PlacedRoutine;
	/** The names of its bot's routines, which a copy's name must not repeat. */
	siblingNames: readonly string[];
	onDuplicated: (copy: Routine) => void;
	onDeleted: () => void;
}) {
	const { routine, agent, pod } = placed;
	const canManage = pod.permissions.manageRoutines;
	const actions = useRoutineActions();
	const [page, setPage] = useState<"routine" | "instructions">("routine");
	// What somebody has picked here, which saves once it rests. Until then the
	// saved schedule shows, read into its parts, and opening it saves nothing.
	const [edited, setEdited] = useState<CalendarSchedule>();
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const scheduled = routine.trigger.kind === "cron" ? routine.trigger : undefined;
	const reading: ScheduleReading = edited
		? { kind: "picked", schedule: edited }
		: scheduled
			? readSchedule(scheduled.schedule)
			: { kind: "picked", schedule: defaultSchedule() };
	const timezone = scheduled?.timezone ?? localTimezone();
	const savedSchedule = scheduled && JSON.stringify(scheduled.schedule);
	const { mutate: update, mutateAsync: updateAsync } = actions.update;
	const addressed = { agentId: agent.id, routineId: routine.id };
	const save = (json: RoutineUpdate) => update({ ...addressed, json });

	// A picked schedule saves once it rests, unless it says nothing new or names no day.
	useEffect(() => {
		if (!edited || savedSchedule === undefined || JSON.stringify(edited) === savedSchedule) return;
		if (!scheduleReady({ kind: "picked", schedule: edited })) return;
		const timer = setTimeout(
			() =>
				update({
					agentId: agent.id,
					routineId: routine.id,
					json: { trigger: { kind: "cron", schedule: edited, timezone } },
				}),
			SCHEDULE_SAVE_DELAY_MS,
		);
		return () => clearTimeout(timer);
	}, [edited, savedSchedule, timezone, update, agent.id, routine.id]);

	function changeTrigger(kind: TriggerKind) {
		save({
			trigger:
				kind === "webhook"
					? { kind: "webhook", auth: DEFAULT_WEBHOOK_AUTH }
					: { kind: "cron", schedule: scheduleOfReading(reading), timezone },
		});
	}

	if (page === "instructions") {
		return (
			<RoutineInstructions
				placed={placed}
				back={
					<PageBackLink
						label={routine.name}
						render={<button type="button" onClick={() => setPage("routine")} />}
					/>
				}
			/>
		);
	}
	return (
		<SettingsPage
			title={routine.name}
			description={
				routine.state === "paused"
					? "Paused. It only runs when you press Run now."
					: `${agent.name} · ${pod.name} pod`
			}
			headerAction={
				<div className="flex gap-2">
					{canManage && (
						<DuplicateButton
							placed={placed}
							siblingNames={siblingNames}
							onDuplicated={onDuplicated}
						/>
					)}
					{pod.permissions.runRoutines && <RunNowButton placed={placed} />}
				</div>
			}
		>
			{actions.update.error && <Alert>{failureMessage(actions.update.error)}</Alert>}
			<SettingsGroup>
				<SwitchRow
					label="Runs on its own"
					checked={routine.state === "enabled"}
					disabled={!canManage}
					onChange={(on) => save({ state: on ? "enabled" : "paused" })}
				/>
				{canManage ? (
					<SettingsNameRow
						key={routine.name}
						name={routine.name}
						maxLength={MAX_ROUTINE_NAME_CHARACTERS}
						savePending={actions.update.isPending}
						error={undefined}
						onCommit={(name) => updateAsync({ ...addressed, json: { name } })}
					/>
				) : (
					<SettingsControlRow label="Name">
						<span className="min-w-0 flex-1 truncate text-[14.5px] text-foreground">
							{routine.name}
						</span>
					</SettingsControlRow>
				)}
				<BotRow chosen={placed} />
				<InstructionsRow
					value={canManage ? "Edit" : "View"}
					onOpen={() => setPage("instructions")}
				/>
			</SettingsGroup>
			<SettingsGroup
				label="When"
				note={
					routine.trigger.kind === "cron" && !scheduleReady(reading)
						? "Pick at least one day for it to run on."
						: whenNote({
								trigger: routine.trigger,
								reading,
								timezone,
								results: routine.results,
								bot: placed,
							})
				}
			>
				<Editable editable={canManage}>
					<TriggerRow value={routine.trigger.kind} onChange={changeTrigger} />
					{routine.trigger.kind === "cron" ? (
						<ScheduleRows reading={reading} onChange={setEdited} />
					) : (
						<WebhookRows
							placed={placed}
							auth={routine.trigger.auth}
							onChangeAuth={(auth) => save({ trigger: { kind: "webhook", auth } })}
						/>
					)}
				</Editable>
			</SettingsGroup>
			<SettingsGroup>
				<Editable editable={canManage}>
					<ResultsRow results={routine.results} onChange={(results) => save({ results })} />
				</Editable>
			</SettingsGroup>
			<RecentRuns placed={placed} />
			{canManage && (
				<>
					<SettingsDanger onClick={() => setConfirmingDelete(true)}>Delete routine</SettingsDanger>
					<DeleteRoutine
						placed={placed}
						open={confirmingDelete}
						onOpenChange={setConfirmingDelete}
						onDeleted={onDeleted}
					/>
				</>
			)}
		</SettingsPage>
	);
}

function localTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The trigger a routine being made saves with: its auth, and the sender's secret if one was pasted. */
function webhookTrigger({ auth, secret }: WebhookDraft) {
	const pasted = secret.trim();
	return pasted === ""
		? { kind: "webhook" as const, auth }
		: { kind: "webhook" as const, auth, secret: pasted };
}

/**
 * The note under When: what the routine does, and for a webhook, what a
 * caller must send to run it.
 */
function whenNote({
	trigger,
	reading,
	timezone,
	results,
	bot,
}: {
	trigger: { kind: "cron" } | { kind: "webhook"; auth: WebhookAuth };
	reading: ScheduleReading;
	/** The schedule's, which the note names, since its times are in it. */
	timezone: string;
	results: RoutineResults;
	bot: BotChoice;
}): string {
	const when =
		trigger.kind === "webhook" ? WEBHOOK_WHEN : `${runsWhen(reading)}, ${zoneName(timezone)}`;
	const summary = routineSummary({ when, results, bot });
	return trigger.kind === "webhook" ? `${summary} ${authNote(trigger.auth)}` : summary;
}

/** What the routine does, under its When: when it runs, and where its result goes. */
function routineSummary({
	when,
	results,
	bot,
}: {
	when: string;
	results: RoutineResults;
	bot: BotChoice;
}): string {
	const chat = `${bot.agent.name}'s chat in the ${bot.pod.name} pod`;
	return results === "post_to_chat"
		? `Runs ${when} and posts the result in ${chat}.`
		: `Runs ${when} and keeps the result in the run, which shows in ${chat}.`;
}

const WEBHOOK_WHEN = "each time the address is called with valid auth";

/** When a scheduled routine runs, as the middle of "Runs … and posts the result". */
function runsWhen(reading: ScheduleReading): string {
	return reading.kind === "written" ? "on its own schedule" : scheduleSummary(reading.schedule);
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

/**
 * Makes a copy of the routine on the same bot, paused so the two don't both
 * run, and opens it. A webhook copy has its own address and a new secret, so
 * a secret its sender made has to be pasted into it again.
 */
function DuplicateButton({
	placed,
	siblingNames,
	onDuplicated,
}: {
	placed: PlacedRoutine;
	siblingNames: readonly string[];
	onDuplicated: (copy: Routine) => void;
}) {
	const { routine, agent } = placed;
	const actions = useRoutineActions();
	const fields = {
		name: copyName(routine.name, siblingNames),
		instructions: routine.instructions,
		results: routine.results,
		state: "paused" as const,
	};
	const copy: NewRoutine =
		routine.trigger.kind === "cron"
			? {
					...fields,
					trigger: {
						kind: "cron",
						schedule: routine.trigger.schedule,
						timezone: routine.trigger.timezone,
					},
				}
			: { ...fields, trigger: { kind: "webhook", auth: routine.trigger.auth } };

	return (
		<div className="flex flex-col items-end gap-1">
			<Button
				variant="secondary"
				disabled={actions.create.isPending}
				onClick={() =>
					actions.create
						.mutateAsync({ agentId: agent.id, json: copy })
						.then((created) => onDuplicated(created.routine))
						.catch(() => {})
				}
			>
				<Copy aria-hidden />
				Duplicate
			</Button>
			{actions.create.error && (
				<span role="alert" className="text-destructive-text text-sm">
					{failureMessage(actions.create.error)}
				</span>
			)}
		</div>
	);
}

/**
 * "{name} copy", or "{name} copy 2" and on when that is taken, shortened to
 * fit a routine's name.
 */
function copyName(name: string, taken: readonly string[]): string {
	for (let number = 1; ; number++) {
		const suffix = number === 1 ? " copy" : ` copy ${number}`;
		const candidate = `${name.slice(0, MAX_ROUTINE_NAME_CHARACTERS - suffix.length)}${suffix}`;
		if (!taken.includes(candidate)) return candidate;
	}
}

function RunNowButton({ placed }: { placed: PlacedRoutine }) {
	const { routine, agent } = placed;
	const actions = useRoutineActions();
	const [starting, setStarting] = useState(false);

	async function runNow() {
		setStarting(true);
		try {
			await Promise.all([
				actions.run.mutateAsync({ agentId: agent.id, routineId: routine.id }),
				new Promise((resolve) => setTimeout(resolve, STARTING_SHOWN_MS)),
			]);
		} catch {
			// The button's title says why.
		} finally {
			setStarting(false);
		}
	}

	return (
		<div className="flex flex-col items-end gap-1">
			<Button disabled={starting} onClick={() => void runNow()}>
				<Play aria-hidden />
				{starting ? "Starting…" : "Run now"}
			</Button>
			{actions.run.error && !starting && (
				<span role="alert" className="text-destructive-text text-sm">
					{failureMessage(actions.run.error)}
				</span>
			)}
		</div>
	);
}

function NameInputRow({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	const id = useId();
	return (
		<SettingsControlRow label="Name" htmlFor={id}>
			<input
				id={id}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				maxLength={MAX_ROUTINE_NAME_CHARACTERS}
				placeholder="e.g. Friday pipeline review"
				className="min-w-0 flex-1 rounded-md bg-transparent text-[14.5px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:shadow-(--ring-shadow)"
			/>
		</SettingsControlRow>
	);
}

/**
 * The routine's bot. Given `choices`, it opens in place to the bots it may be
 * made for, under their pods' names; without them it only shows the bot.
 */
function BotRow({
	chosen,
	choices,
	onChoose,
}: {
	chosen: BotChoice | undefined;
	choices?: readonly BotChoice[];
	onChoose?: (agentId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const choosable = choices && onChoose && choices.length > 1;
	const pods = [...new Map(choices?.map((choice) => [choice.pod.id, choice.pod])).values()];
	const summary = chosen ? (
		<span className="flex min-w-0 flex-1 items-center gap-2.5">
			<AgentAvatar color={chosen.agent.color} face={chosen.agent.face} size={24} />
			<span className="truncate text-[14.5px] text-foreground">{chosen.agent.name}</span>
			<span className="truncate text-muted-foreground text-sm">{chosen.pod.name}</span>
		</span>
	) : (
		<span className="flex-1 text-[14.5px] text-muted-foreground">Choose a bot</span>
	);

	if (!choosable) {
		return <SettingsControlRow label="Bot">{summary}</SettingsControlRow>;
	}
	return (
		<div className="border-border border-b last:border-b-0">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="focus-ring flex min-h-[46px] w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-panel"
			>
				<SettingsFieldLabel>Bot</SettingsFieldLabel>
				{summary}
				<ChevronRight
					aria-hidden
					size={15}
					strokeWidth={2.4}
					className={cn(
						"shrink-0 text-subtle-foreground transition-transform duration-150",
						open && "rotate-90",
					)}
				/>
			</button>
			{open &&
				pods.map((pod) => (
					<section key={pod.id} aria-label={pod.name} className="pb-1.5 pl-[116px]">
						<h3 className="m-0 px-1 pt-1 pb-1 font-medium text-sm text-subtle-foreground">
							{pod.name}
						</h3>
						<ul className="m-0 flex list-none flex-col p-0 pr-2">
							{choices
								.filter((choice) => choice.pod.id === pod.id)
								.map(({ agent }) => (
									<li key={agent.id}>
										<button
											type="button"
											aria-pressed={agent.id === chosen?.agent.id}
											onClick={() => {
												onChoose(agent.id);
												setOpen(false);
											}}
											className="focus-ring flex w-full items-center gap-2.5 rounded-xl px-1 py-1.5 text-left transition-colors hover:bg-row-hover"
										>
											<AgentAvatar color={agent.color} face={agent.face} size={24} />
											<span className="min-w-0 flex-1 truncate text-[14.5px] text-foreground">
												{agent.name}
											</span>
											{agent.id === chosen?.agent.id && (
												<Check aria-hidden size={16} strokeWidth={2.4} className="text-link" />
											)}
										</button>
									</li>
								))}
						</ul>
					</section>
				))}
		</div>
	);
}

/** The routine's instructions, as a row that opens them on a page of their own. */
function InstructionsRow({
	value,
	onOpen,
}: {
	value: "Add" | "Edit" | "View";
	onOpen: () => void;
}) {
	return (
		<SettingsRow
			label="Instructions"
			trailing={<SettingsValue>{value}</SettingsValue>}
			chevron
			onClick={onOpen}
		/>
	);
}

/** An existing routine's instructions, saved with Save, as a bot's are. */
function RoutineInstructions({ placed, back }: { placed: PlacedRoutine; back: ReactNode }) {
	const { routine, agent, pod } = placed;
	const editable = pod.permissions.manageRoutines;
	const actions = useRoutineActions();
	const [draft, setDraft] = useState(routine.instructions);
	const next = draft.trim();
	const savable = next !== "" && next !== routine.instructions;

	return (
		<InstructionsPage
			back={back}
			botName={agent.name}
			value={draft}
			onChange={setDraft}
			editable={editable}
			error={actions.update.error ? failureMessage(actions.update.error) : undefined}
			action={
				<Button
					disabled={!savable || actions.update.isPending}
					onClick={() =>
						actions.update.mutate({
							agentId: agent.id,
							routineId: routine.id,
							json: { instructions: next },
						})
					}
				>
					{actions.update.isPending ? "Saving…" : "Save"}
				</Button>
			}
		/>
	);
}

const countFormat = new Intl.NumberFormat("en");

/** What a routine tells its bot each time it runs, on a page of its own with room to write. */
function InstructionsPage({
	back,
	botName,
	value,
	onChange,
	editable,
	error,
	action,
}: {
	back: ReactNode;
	botName: string | undefined;
	value: string;
	onChange: (value: string) => void;
	editable: boolean;
	error?: string;
	/** What finishes the writing, under it: Save, or Done for a routine not made yet. */
	action: ReactNode;
}) {
	const id = useId();
	return (
		<SettingsPage
			back={back}
			title="Instructions"
			description={`What ${botName ?? "the bot"} does each time this runs.`}
		>
			{error && <Alert>{error}</Alert>}
			<SettingsGroup
				className="p-1"
				note={
					editable
						? `Say what to look at, what to do, and what a good result looks like. ${countFormat.format(value.length)} of ${countFormat.format(MAX_ROUTINE_INSTRUCTIONS_CHARACTERS)} characters.`
						: undefined
				}
			>
				<label htmlFor={id} className="sr-only">
					Instructions
				</label>
				<textarea
					id={id}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					readOnly={!editable}
					maxLength={MAX_ROUTINE_INSTRUCTIONS_CHARACTERS}
					placeholder="e.g. Summarise this week's replies and flag anything that has stalled."
					className="block min-h-[380px] w-full resize-y rounded-[12px] bg-transparent p-3.5 text-[14.5px] text-foreground leading-[1.65] outline-none placeholder:text-subtle-foreground focus-visible:shadow-(--ring-shadow)"
				/>
			</SettingsGroup>
			{editable && <div className="flex justify-end">{action}</div>}
		</SettingsPage>
	);
}

/**
 * Rows only a manager may change. A fieldset disables every control in it at
 * once, and lays out nothing of its own, so the rows stay their group's.
 */
function Editable({ editable, children }: { editable: boolean; children: ReactNode }) {
	return (
		<fieldset disabled={!editable} className="contents">
			{children}
		</fieldset>
	);
}

function TriggerRow({
	value,
	onChange,
}: {
	value: TriggerKind;
	onChange: (kind: TriggerKind) => void;
}) {
	return (
		<SettingsChoiceRow
			label="Trigger"
			options={TRIGGER_OPTIONS}
			value={value}
			onChange={onChange}
		/>
	);
}

function ResultsRow({
	results,
	onChange,
}: {
	results: RoutineResults;
	onChange: (results: RoutineResults) => void;
}) {
	return (
		<SwitchRow
			label="Post result to chat"
			checked={results === "post_to_chat"}
			onChange={(posted) => onChange(posted ? "post_to_chat" : "keep_in_run")}
		/>
	);
}

/** A row that is a switch, named by its label. */
function SwitchRow({
	label,
	checked,
	disabled,
	onChange,
}: {
	label: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex min-h-[46px] items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0">
			<span className="flex-1 text-[14.5px] text-foreground">{label}</span>
			<Toggle label={label} checked={checked} disabled={disabled} onChange={onChange} />
		</div>
	);
}

function DeleteRoutine({
	placed,
	open,
	onOpenChange,
	onDeleted,
}: {
	placed: PlacedRoutine;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onDeleted: () => void;
}) {
	const actions = useRoutineActions();
	return (
		<DeleteDialog
			open={open}
			onOpenChange={onOpenChange}
			title={`Delete ${placed.routine.name}?`}
			description="It stops running. Runs already in its bot's chat stay there."
			pending={actions.remove.isPending}
			error={actions.remove.error ? failureMessage(actions.remove.error) : undefined}
			onDelete={async () => {
				try {
					await actions.remove.mutateAsync({
						agentId: placed.agent.id,
						routineId: placed.routine.id,
					});
				} catch {
					return;
				}
				onDeleted();
			}}
		/>
	);
}
