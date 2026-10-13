import {
	type Agent,
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
import { Check, ChevronRight, Minus, Play, Plus } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import {
	cronExpression,
	DAY_OPTIONS,
	DEFAULT_SCHEDULE,
	formatTime,
	hasDays,
	REPEAT_OPTIONS,
	readSchedule,
	type Schedule,
	type ScheduleReading,
	scheduleSummary,
	stepTime,
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
const TIME_STEP_MINUTES = 30;

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
	const [reading, setReading] = useState<ScheduleReading>({
		kind: "preset",
		schedule: DEFAULT_SCHEDULE,
	});
	const [webhook, setWebhook] = useState(NEW_WEBHOOK);
	const [page, setPage] = useState<"routine" | "instructions">("routine");
	const actions = useRoutineActions();
	const bot = choices.find((choice) => choice.agent.id === agentId);
	const results = chosenResults ?? DEFAULT_RESULTS[kind];
	const scheduleReady = kind === "webhook" || reading.kind === "other" || hasDays(reading.schedule);
	const secretReady = kind === "cron" || pastedSecretReady(webhook.secret);
	const ready =
		bot !== undefined &&
		name.trim() !== "" &&
		instructions.trim() !== "" &&
		scheduleReady &&
		secretReady;

	async function create() {
		if (!bot || !ready) return;
		const fields = { name, instructions, results };
		const input: NewRoutine =
			kind === "cron"
				? { ...fields, trigger: { kind: "cron", ...cronTrigger(reading, localTimezone()) } }
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
					(!scheduleReady
						? "Pick at least one day for it to run on."
						: !secretReady
							? `A pasted secret needs at least ${MIN_WEBHOOK_SECRET_CHARACTERS} characters.`
							: whenNote({
									trigger: kind === "cron" ? { kind } : { kind, auth: webhook.auth },
									reading,
									results,
									bot,
								}))
				}
			>
				<TriggerRow value={kind} onChange={setKind} />
				{kind === "cron" ? (
					<ScheduleRows reading={reading} onChange={setReading} />
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
	onDeleted,
}: {
	placed: PlacedRoutine;
	onDeleted: () => void;
}) {
	const { routine, agent, pod } = placed;
	const canManage = pod.permissions.manageRoutines;
	const actions = useRoutineActions();
	const [page, setPage] = useState<"routine" | "instructions">("routine");
	const [reading, setReading] = useState<ScheduleReading>(
		routine.trigger.kind === "cron"
			? readSchedule(routine.trigger.expression)
			: { kind: "preset", schedule: DEFAULT_SCHEDULE },
	);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const timezone = routine.trigger.kind === "cron" ? routine.trigger.timezone : localTimezone();
	const savedExpression = routine.trigger.kind === "cron" ? routine.trigger.expression : undefined;
	const { mutate: update, mutateAsync: updateAsync } = actions.update;
	const addressed = { agentId: agent.id, routineId: routine.id };
	const save = (json: RoutineUpdate) => update({ ...addressed, json });

	// A schedule saves once it rests, unless it says nothing new or names no day.
	useEffect(() => {
		if (savedExpression === undefined || reading.kind !== "preset" || !hasDays(reading.schedule)) {
			return;
		}
		const expression = cronExpression(reading.schedule);
		if (expression === savedExpression) return;
		const timer = setTimeout(
			() =>
				update({
					agentId: agent.id,
					routineId: routine.id,
					json: { trigger: { kind: "cron", expression, timezone } },
				}),
			SCHEDULE_SAVE_DELAY_MS,
		);
		return () => clearTimeout(timer);
	}, [reading, savedExpression, timezone, update, agent.id, routine.id]);

	function changeTrigger(kind: TriggerKind) {
		save({
			trigger:
				kind === "webhook"
					? { kind: "webhook", auth: DEFAULT_WEBHOOK_AUTH }
					: { kind: "cron", ...cronTrigger(reading, timezone) },
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
			headerAction={pod.permissions.runRoutines && <RunNowButton placed={placed} />}
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
					routine.trigger.kind === "cron" && reading.kind === "preset" && !hasDays(reading.schedule)
						? "Pick at least one day for it to run on."
						: whenNote({
								trigger: routine.trigger,
								reading,
								results: routine.results,
								bot: placed,
							})
				}
			>
				<Editable editable={canManage}>
					<TriggerRow value={routine.trigger.kind} onChange={changeTrigger} />
					{routine.trigger.kind === "cron" ? (
						<ScheduleRows reading={reading} onChange={setReading} />
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

/** The cron trigger a schedule reading saves as: a picked repeat, or the expression kept as it was. */
function cronTrigger(reading: ScheduleReading, timezone: string) {
	const expression =
		reading.kind === "preset" ? cronExpression(reading.schedule) : reading.expression;
	return { expression, timezone };
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
	results,
	bot,
}: {
	trigger: { kind: "cron" } | { kind: "webhook"; auth: WebhookAuth };
	reading: ScheduleReading;
	results: RoutineResults;
	bot: BotChoice;
}): string {
	const summary = routineSummary({ when: runsWhen(trigger.kind, reading), results, bot });
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

/** When a routine runs, as the middle of "Runs … and posts the result". */
function runsWhen(kind: TriggerKind, reading: ScheduleReading): string {
	if (kind === "webhook") return "each time the address is called with valid auth";
	if (reading.kind === "other") return "on its own schedule";
	const summary = scheduleSummary(reading.schedule);
	// Day names keep their capital; "Every day" and "Weekdays" start the sentence's middle.
	return reading.schedule.repeat === "weekly"
		? summary
		: `${summary.charAt(0).toLowerCase()}${summary.slice(1)}`;
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

function ScheduleRows({
	reading,
	onChange,
}: {
	reading: ScheduleReading;
	onChange: (reading: ScheduleReading) => void;
}) {
	const schedule = reading.kind === "preset" ? reading.schedule : undefined;
	const change = (next: Partial<Schedule>) =>
		onChange({ kind: "preset", schedule: { ...(schedule ?? DEFAULT_SCHEDULE), ...next } });
	const minutes = schedule?.minutesPastMidnight ?? DEFAULT_SCHEDULE.minutesPastMidnight;

	return (
		<>
			<SettingsChoiceRow
				label="Repeat"
				options={REPEAT_OPTIONS}
				value={schedule?.repeat}
				onChange={(repeat) =>
					// A daily or weekday schedule has no days of its own, so Weekly starts on Monday.
					change({
						repeat,
						days: schedule?.days.length ? schedule.days : DEFAULT_SCHEDULE.days,
					})
				}
			/>
			{reading.kind === "other" && (
				<div className="flex flex-col gap-1 border-border border-b px-4 py-3">
					<span className="text-[14.5px] text-foreground">{reading.label}</span>
					<code className="font-mono text-[13px] text-muted-foreground">{reading.expression}</code>
					<span className="text-sm text-subtle-foreground">Pick a repeat to replace it.</span>
				</div>
			)}
			{schedule?.repeat === "weekly" && (
				<fieldset className="m-0 grid grid-cols-7 gap-1.5 border-0 border-border border-b px-4 py-2.5">
					<legend className="sr-only">Days</legend>
					{DAY_OPTIONS.map((day) => {
						const selected = schedule.days.includes(day.cron);
						return (
							<label
								key={day.cron}
								title={day.long}
								className="focus-ring-within mx-auto grid aspect-square w-full max-w-11 cursor-pointer place-items-center rounded-full bg-chip font-medium text-[13px] text-soft-foreground transition-colors has-checked:bg-primary has-checked:text-primary-foreground"
							>
								<input
									type="checkbox"
									aria-label={day.long}
									checked={selected}
									onChange={() =>
										change({
											days: selected
												? schedule.days.filter((value) => value !== day.cron)
												: [...schedule.days, day.cron],
										})
									}
									className="sr-only"
								/>
								<span aria-hidden>{day.letter}</span>
							</label>
						);
					})}
				</fieldset>
			)}
			{schedule && (
				<SettingsControlRow label="Time">
					<span className="flex flex-1 items-center justify-end gap-3">
						<StepButton
							label="30 minutes earlier"
							onClick={() => change({ minutesPastMidnight: stepTime(minutes, -TIME_STEP_MINUTES) })}
						>
							<Minus size={14} strokeWidth={2.4} />
						</StepButton>
						<output
							aria-label="Time"
							className="w-14 text-center font-semibold text-[16px] text-foreground tabular-nums"
						>
							{formatTime(minutes)}
						</output>
						<StepButton
							label="30 minutes later"
							onClick={() => change({ minutesPastMidnight: stepTime(minutes, TIME_STEP_MINUTES) })}
						>
							<Plus size={14} strokeWidth={2.4} />
						</StepButton>
					</span>
				</SettingsControlRow>
			)}
		</>
	);
}

function StepButton({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			onClick={onClick}
			className="focus-ring grid size-[30px] shrink-0 place-items-center rounded-full bg-chip text-foreground transition-colors hover:bg-hover disabled:opacity-45"
		>
			{children}
		</button>
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
