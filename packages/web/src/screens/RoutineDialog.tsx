import {
	type Agent,
	MAX_ROUTINE_INSTRUCTIONS_CHARACTERS,
	MAX_ROUTINE_NAME_CHARACTERS,
	type NewRoutine,
	type Pod,
	type Routine,
	type RoutineResults,
} from "@sugabots/contracts";
import { Check, ChevronLeft, ChevronRight, Minus, Plus, Search } from "lucide-react";
import { type ReactNode, useDeferredValue, useId, useState } from "react";
import { apiBaseUrl } from "@/lib/api-url.ts";
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
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { DialogTitle } from "@/ui/dialog.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
} from "@/ui/dialog-form.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import { SettingsDanger, SettingsGroup } from "@/ui/settings-page.tsx";
import { Textarea } from "@/ui/textarea.tsx";
import { Toggle } from "@/ui/toggle.tsx";

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

/** A webhook's secret, which the API hands over once: when the routine is made, or when it is reset. */
interface Credential {
	routineId: string;
	secret: string;
}

/*
 * New routine, or an existing one opened from its row. The fields are one
 * card of rows; the bot and the instructions each open a page of their own in
 * the same dialog, so the form never rearranges under you.
 *
 * A routine stays with the bot it was made for, since the API addresses it
 * through that bot, so an existing routine shows its bot without a way to
 * change it. A webhook's secret exists only once the routine does and is
 * shown only then, so making a webhook routine keeps the dialog open on its
 * address and secret until Done.
 */
export function RoutineDialog({
	editing,
	choices,
	onClose,
}: {
	/** The routine being changed; absent for a new one. */
	editing?: PlacedRoutine;
	/** The bots a new routine may be made for, in the order the picker lists them. */
	choices: readonly BotChoice[];
	onClose: () => void;
}) {
	const routine = editing?.routine;
	const initialReading: ScheduleReading =
		routine?.trigger.kind === "cron"
			? readSchedule(routine.trigger.expression)
			: { kind: "preset", schedule: DEFAULT_SCHEDULE };
	const [page, setPage] = useState<"form" | "bot" | "instructions">("form");
	const [name, setName] = useState(routine?.name ?? "");
	const [instructions, setInstructions] = useState(routine?.instructions ?? "");
	const [agentId, setAgentId] = useState(editing?.agent.id ?? choices[0]?.agent.id);
	const [kind, setKind] = useState<TriggerKind>(routine?.trigger.kind ?? "cron");
	// Unset until chosen, so a new routine's follows its trigger's default.
	const [chosenResults, setChosenResults] = useState(routine?.results);
	const results = chosenResults ?? DEFAULT_RESULTS[kind];
	const [reading, setReading] = useState(initialReading);
	const [credential, setCredential] = useState<Credential>();
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const actions = useRoutineActions();
	const bot = editing ?? choices.find((choice) => choice.agent.id === agentId);
	const pending = actions.create.isPending || actions.update.isPending;
	const error = actions.create.error ?? actions.update.error;
	const timezone =
		routine?.trigger.kind === "cron"
			? routine.trigger.timezone
			: Intl.DateTimeFormat().resolvedOptions().timeZone;
	const scheduleReady = kind === "webhook" || reading.kind === "other" || hasDays(reading.schedule);
	const ready =
		bot !== undefined && name.trim() !== "" && instructions.trim() !== "" && scheduleReady;

	async function save() {
		if (!bot || !ready) return;
		const expression =
			reading.kind === "preset" ? cronExpression(reading.schedule) : reading.expression;
		const fields = { name, instructions, results };
		const input: NewRoutine =
			kind === "cron"
				? { ...fields, trigger: { kind: "cron", expression, timezone } }
				: { ...fields, trigger: { kind: "webhook" } };
		let saved: { routine: Routine; secret: string | null };
		try {
			saved = routine
				? await actions.update.mutateAsync({
						agentId: bot.agent.id,
						routineId: routine.id,
						json: input,
					})
				: await actions.create.mutateAsync({ agentId: bot.agent.id, json: input });
		} catch {
			return;
		}
		// A routine that has just become a webhook has a secret for the first time.
		if (saved.secret) {
			setCredential({ routineId: saved.routine.id, secret: saved.secret });
			return;
		}
		onClose();
	}

	if (credential && bot) {
		return <WebhookCreated credential={credential} bot={bot} onDone={onClose} />;
	}
	if (page === "bot") {
		return (
			<BotPicker
				choices={choices}
				chosenId={agentId}
				onChoose={(id) => {
					setAgentId(id);
					setPage("form");
				}}
				onBack={() => setPage("form")}
			/>
		);
	}
	if (page === "instructions") {
		return (
			<DialogForm
				onSubmit={(event) => {
					event.preventDefault();
					setPage("form");
				}}
			>
				<SlideHeader title="Instructions" onBack={() => setPage("form")} />
				<DialogFormBody>
					<Textarea
						aria-label="Instructions"
						value={instructions}
						onChange={(event) => setInstructions(event.target.value)}
						maxLength={MAX_ROUTINE_INSTRUCTIONS_CHARACTERS}
						placeholder="e.g. Summarise this week's replies and flag anything that has stalled."
						className="min-h-[360px] text-[14.5px] leading-relaxed"
						autoFocus
					/>
					<p className="m-0 px-1 text-sm text-subtle-foreground">
						What {bot?.agent.name ?? "the bot"} should do each time this runs.
					</p>
				</DialogFormBody>
			</DialogForm>
		);
	}

	return (
		<DialogForm
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<DialogFormHeader title={routine ? "Edit routine" : "New routine"} />
			<DialogFormBody>
				{error && <Alert>{failureMessage(error)}</Alert>}
				<SettingsGroup>
					<NameRow value={name} onChange={setName} />
					<FieldRow
						label="Bot"
						onClick={routine || choices.length < 2 ? undefined : () => setPage("bot")}
					>
						{bot ? (
							<span className="flex min-w-0 items-center gap-2.5">
								<AgentAvatar color={bot.agent.color} face={bot.agent.face} size={26} />
								<span className="truncate text-foreground">{bot.agent.name}</span>
							</span>
						) : (
							<span className="text-muted-foreground">Choose a bot</span>
						)}
					</FieldRow>
					<FieldRow label="Instructions" onClick={() => setPage("instructions")}>
						<span
							className={instructions.trim() ? "truncate text-foreground" : "text-muted-foreground"}
						>
							{instructions.trim() || "Add"}
						</span>
					</FieldRow>
				</SettingsGroup>
				<SettingsGroup label="When">
					<div className="flex items-center gap-3 border-border border-b px-4 py-2.5">
						<span className="flex-1 text-[14.5px] text-foreground">Trigger</span>
						<SegmentedControl
							label="Trigger"
							options={TRIGGER_OPTIONS}
							value={kind}
							onChange={setKind}
						/>
					</div>
					{kind === "cron" ? (
						<ScheduleRows reading={reading} onChange={setReading} />
					) : (
						<WebhookRows editing={editing} />
					)}
				</SettingsGroup>
				<SettingsGroup>
					<div className="flex items-center gap-3 px-4 py-2.5">
						<span className="flex-1 text-[14.5px] text-foreground">Post result to chat</span>
						<Toggle
							label="Post result to chat"
							checked={results === "post_to_chat"}
							onChange={(posted) => setChosenResults(posted ? "post_to_chat" : "keep_in_run")}
						/>
					</div>
				</SettingsGroup>
				{bot && (
					<p className="-mt-1.5 m-0 px-1 text-sm text-subtle-foreground leading-normal">
						{!scheduleReady
							? "Pick at least one day for it to run on."
							: routineSummary({
									when:
										kind === "webhook"
											? "whenever the address is called with the secret"
											: runsWhen(reading),
									results,
									bot,
								})}
					</p>
				)}
				{editing && (
					<>
						<SettingsDanger onClick={() => setConfirmingDelete(true)}>
							Delete routine
						</SettingsDanger>
						<DeleteRoutine
							editing={editing}
							open={confirmingDelete}
							onOpenChange={setConfirmingDelete}
							onDeleted={onClose}
						/>
					</>
				)}
			</DialogFormBody>
			<DialogFormFooter
				action={routine ? "Save" : "Create"}
				actionDisabled={pending || !ready}
				cancelDisabled={pending}
				onCancel={onClose}
			/>
		</DialogForm>
	);
}

/** What the routine does, under its fields: when it runs, and where its result goes. */
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

/** When a schedule runs, as the middle of "Runs … and posts the result". */
function runsWhen(reading: ScheduleReading): string {
	if (reading.kind === "other") return "on its own schedule";
	const summary = scheduleSummary(reading.schedule);
	// Day names keep their capital; "Every day" and "Weekdays" start the sentence's middle.
	return reading.schedule.repeat === "weekly"
		? summary
		: `${summary.charAt(0).toLowerCase()}${summary.slice(1)}`;
}

function NameRow({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	const id = useId();
	return (
		<div className="flex items-center gap-3 border-border border-b px-4 py-3">
			<label htmlFor={id} className="w-24 shrink-0 text-[14.5px] text-foreground">
				Name
			</label>
			<input
				id={id}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				maxLength={MAX_ROUTINE_NAME_CHARACTERS}
				placeholder="e.g. Friday pipeline review"
				className="min-w-0 flex-1 rounded-md bg-transparent text-[14.5px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:shadow-(--ring-shadow)"
			/>
		</div>
	);
}

/** A labelled row whose value opens a page of its own, or just shows it when `onClick` is absent. */
function FieldRow({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick?: () => void;
	children: ReactNode;
}) {
	const content = (
		<>
			<span className="w-24 shrink-0 text-[14.5px] text-foreground">{label}</span>
			<span className="flex min-w-0 flex-1 text-[14.5px]">{children}</span>
			{onClick && (
				<ChevronRight
					aria-hidden
					size={15}
					strokeWidth={2.4}
					className="shrink-0 text-subtle-foreground"
				/>
			)}
		</>
	);
	const row =
		"flex w-full min-w-0 items-center gap-3 border-border border-b px-4 py-3 text-left last:border-b-0";
	if (!onClick) return <div className={row}>{content}</div>;
	return (
		<button
			type="button"
			aria-label={label}
			onClick={onClick}
			className={`${row} focus-ring cursor-pointer transition-colors hover:bg-panel`}
		>
			{content}
		</button>
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
			<div className="flex items-center gap-3 border-border border-b px-4 py-2.5">
				<span className="flex-1 text-[14.5px] text-foreground">Repeat</span>
				<SegmentedControl
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
			</div>
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
								className="focus-ring-within grid h-8 cursor-pointer place-items-center rounded-full bg-chip font-medium text-[13px] text-soft-foreground transition-colors has-checked:bg-primary has-checked:text-primary-foreground"
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
				<div className="flex items-center gap-3 px-4 py-2.5">
					<span className="flex-1 text-[14.5px] text-foreground">Time</span>
					<StepButton
						label="Earlier"
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
						label="Later"
						onClick={() => change({ minutesPastMidnight: stepTime(minutes, TIME_STEP_MINUTES) })}
					>
						<Plus size={14} strokeWidth={2.4} />
					</StepButton>
				</div>
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
			className="focus-ring grid size-[30px] shrink-0 place-items-center rounded-full bg-chip text-foreground transition-colors hover:bg-hover"
		>
			{children}
		</button>
	);
}

/**
 * The address and secret of an existing webhook routine. The API keeps only a
 * hash of the secret, so it cannot be shown again; Reset makes a new one, which
 * is shown then, and the old one stops working at once.
 */
function WebhookRows({ editing }: { editing?: PlacedRoutine }) {
	const actions = useRoutineActions();
	const [confirmingReset, setConfirmingReset] = useState(false);
	const [secret, setSecret] = useState<string>();
	const routine = editing?.routine.trigger.kind === "webhook" ? editing.routine : undefined;

	if (!editing || !routine) {
		return (
			<div className="flex items-center gap-3 px-4 py-3">
				<span className="w-24 shrink-0 text-[14.5px] text-foreground">Address</span>
				<span className="text-[14.5px] text-muted-foreground">Made when you save</span>
			</div>
		);
	}
	return (
		<>
			<AddressRow routineId={routine.id} />
			{secret ? (
				<SecretRow secret={secret} />
			) : (
				<div className="flex items-center gap-3 px-4 py-3">
					<span className="w-24 shrink-0 text-[14.5px] text-foreground">Secret</span>
					<span className="min-w-0 flex-1 truncate text-[14px] text-muted-foreground">
						Shown only when it's made
					</span>
					<TextButton onClick={() => setConfirmingReset(true)}>Reset</TextButton>
				</div>
			)}
			<DeleteDialog
				open={confirmingReset}
				onOpenChange={setConfirmingReset}
				title="Reset the secret?"
				description="The current secret stops working straight away, so anything calling this address needs the new one."
				confirmLabel="Reset"
				pending={actions.rotateSecret.isPending}
				error={actions.rotateSecret.error ? failureMessage(actions.rotateSecret.error) : undefined}
				onDelete={async () => {
					try {
						const rotated = await actions.rotateSecret.mutateAsync({
							agentId: editing.agent.id,
							routineId: routine.id,
						});
						setSecret(rotated.secret);
						setConfirmingReset(false);
					} catch {
						return;
					}
				}}
			/>
		</>
	);
}

function webhookAddress(routineId: string): string {
	return `${apiBaseUrl}/hooks/routines/${routineId}`;
}

function AddressRow({ routineId }: { routineId: string }) {
	const address = webhookAddress(routineId);
	return (
		<div className="flex items-center gap-3 border-border border-b px-4 py-3">
			<span className="w-24 shrink-0 text-[14.5px] text-foreground">Address</span>
			<code className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
				{address}
			</code>
			<CopyButton label="Copy address" value={address} />
		</div>
	);
}

/** How much of a secret stays readable while it is hidden: enough to tell two apart. */
const SECRET_SHOWN_PREFIX = 6;

function SecretRow({ secret }: { secret: string }) {
	const [shown, setShown] = useState(false);
	return (
		<div className="flex items-center gap-3 px-4 py-3">
			<span className="w-24 shrink-0 text-[14.5px] text-foreground">Secret</span>
			<code className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
				{shown ? secret : `${secret.slice(0, SECRET_SHOWN_PREFIX)}${"•".repeat(16)}`}
			</code>
			<TextButton onClick={() => setShown(!shown)} muted>
				{shown ? "Hide" : "Show"}
			</TextButton>
			<CopyButton label="Copy secret" value={secret} />
		</div>
	);
}

function CopyButton({ label, value }: { label: string; value: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<TextButton
			ariaLabel={label}
			onClick={() => {
				void navigator.clipboard
					?.writeText(value)
					.then(() => setCopied(true))
					.catch(() => setCopied(false));
			}}
		>
			{copied ? "Copied" : "Copy"}
		</TextButton>
	);
}

function TextButton({
	onClick,
	muted = false,
	ariaLabel,
	children,
}: {
	onClick: () => void;
	muted?: boolean;
	ariaLabel?: string;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={ariaLabel}
			onClick={onClick}
			className={`focus-ring shrink-0 rounded-md font-medium text-[13.5px] ${muted ? "text-soft-foreground" : "text-link"}`}
		>
			{children}
		</button>
	);
}

/** What a new webhook routine answers to, shown once before the dialog closes. */
function WebhookCreated({
	credential,
	bot,
	onDone,
}: {
	credential: Credential;
	bot: BotChoice;
	onDone: () => void;
}) {
	return (
		<DialogForm
			onSubmit={(event) => {
				event.preventDefault();
				onDone();
			}}
		>
			<DialogFormHeader title="Webhook ready" />
			<DialogFormBody>
				<SettingsGroup
					note={`Copy the secret now: it isn't shown again. Calls to the address with it post into ${bot.agent.name}'s chat.`}
				>
					<AddressRow routineId={credential.routineId} />
					<SecretRow secret={credential.secret} />
				</SettingsGroup>
			</DialogFormBody>
			<DialogFormFooter action="Done" cancel={false} />
		</DialogForm>
	);
}

function DeleteRoutine({
	editing,
	open,
	onOpenChange,
	onDeleted,
}: {
	editing: PlacedRoutine;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onDeleted: () => void;
}) {
	const actions = useRoutineActions();
	return (
		<DeleteDialog
			open={open}
			onOpenChange={onOpenChange}
			title={`Delete ${editing.routine.name}?`}
			description="It stops running. Runs already in its bot's chat stay there."
			pending={actions.remove.isPending}
			error={actions.remove.error ? failureMessage(actions.remove.error) : undefined}
			onDelete={async () => {
				try {
					await actions.remove.mutateAsync({
						agentId: editing.agent.id,
						routineId: editing.routine.id,
					});
				} catch {
					return;
				}
				onDeleted();
			}}
		/>
	);
}

function SlideHeader({ title, onBack }: { title: string; onBack: () => void }) {
	return (
		<header className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-[18px] pt-4 pb-3">
			<button
				type="button"
				onClick={onBack}
				className="focus-ring flex items-center gap-0.5 justify-self-start rounded-md text-[14.5px] text-link"
			>
				<ChevronLeft aria-hidden size={16} />
				Back
			</button>
			<DialogTitle className="text-center font-semibold text-[15px] text-foreground">
				{title}
			</DialogTitle>
			<span />
		</header>
	);
}

/** The bots a routine can be made for, under their pods' names, with a search over them. */
function BotPicker({
	choices,
	chosenId,
	onChoose,
	onBack,
}: {
	choices: readonly BotChoice[];
	chosenId: string | undefined;
	onChoose: (agentId: string) => void;
	onBack: () => void;
}) {
	const [search, setSearch] = useState("");
	const needle = useDeferredValue(search.trim().toLowerCase());
	const shown = choices.filter(
		(choice) => needle === "" || choice.agent.name.toLowerCase().includes(needle),
	);
	const pods = [...new Map(shown.map((choice) => [choice.pod.id, choice.pod])).values()];

	return (
		<DialogForm onSubmit={(event) => event.preventDefault()}>
			<SlideHeader title="Bot" onBack={onBack} />
			<DialogFormBody>
				<label className="focus-ring-within flex items-center gap-[9px] rounded-xl bg-chip px-3">
					<Search aria-hidden size={15} className="shrink-0 text-muted-foreground" />
					<input
						type="search"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Search bots"
						aria-label="Search bots"
						className="min-w-0 flex-1 bg-transparent py-[9px] text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
					/>
				</label>
				{pods.map((pod) => (
					<section key={pod.id} className="flex flex-col gap-0.5">
						<h3 className="m-0 px-1 pb-1 font-medium text-sm text-subtle-foreground">{pod.name}</h3>
						<ul className="m-0 flex list-none flex-col p-0">
							{shown
								.filter((choice) => choice.pod.id === pod.id)
								.map(({ agent }) => (
									<li key={agent.id}>
										<button
											type="button"
											aria-pressed={agent.id === chosenId}
											onClick={() => onChoose(agent.id)}
											className="focus-ring flex w-full items-center gap-3 rounded-xl px-1 py-2 text-left transition-colors hover:bg-row-hover"
										>
											<AgentAvatar color={agent.color} face={agent.face} size={26} />
											<span className="min-w-0 flex-1 truncate text-[14.5px] text-foreground">
												{agent.name}
											</span>
											{agent.id === chosenId && (
												<Check aria-hidden size={16} strokeWidth={2.4} className="text-link" />
											)}
										</button>
									</li>
								))}
						</ul>
					</section>
				))}
				{shown.length === 0 && (
					<p className="m-0 px-1 text-muted-foreground text-sm">No bots match “{search.trim()}”.</p>
				)}
			</DialogFormBody>
		</DialogForm>
	);
}
