import type {
	Agent,
	NewRoutine,
	Routine,
	RoutineExecution,
	RoutineUpdate,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import {
	AlarmClock,
	Ban,
	Check,
	CircleAlert,
	Clock3,
	Copy,
	Ellipsis,
	LockKeyhole,
	Pause,
	Pencil,
	Play,
	Plus,
	RefreshCw,
	Trash2,
	Webhook,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { apiBaseUrl } from "@/lib/api-url.ts";
import { failureMessage } from "@/lib/failure.ts";
import { useRoutineActions, useRoutineExecutions, useRoutines } from "@/lib/routines.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/ui/dialog.tsx";
import { DialogForm, DialogFormBody, DialogFormFooter } from "@/ui/dialog-form.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { Field } from "@/ui/field.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Input } from "@/ui/input.tsx";
import { Textarea } from "@/ui/textarea.tsx";

const DAY_OPTIONS = [
	{ short: "Mon", long: "Monday", cron: "1" },
	{ short: "Tue", long: "Tuesday", cron: "2" },
	{ short: "Wed", long: "Wednesday", cron: "3" },
	{ short: "Thu", long: "Thursday", cron: "4" },
	{ short: "Fri", long: "Friday", cron: "5" },
	{ short: "Sat", long: "Saturday", cron: "6" },
	{ short: "Sun", long: "Sunday", cron: "0" },
] as const;

const SCHEDULE_PRESETS = [
	{ value: "daily", label: "Every day" },
	{ value: "weekdays", label: "Every weekday" },
	{ value: "specific", label: "Specific days" },
	{ value: "hourly", label: "Every hour" },
] as const;

type SchedulePreset = (typeof SCHEDULE_PRESETS)[number]["value"] | "custom";

interface ScheduleDraft {
	preset: SchedulePreset;
	days: string[];
	time: string;
	expression: string;
}

export function RoutinesSettings({
	agent,
	canManage,
	canRun,
}: {
	agent: Agent;
	canManage: boolean;
	/** Starting a Routine by hand is its own permission, separate from editing one. */
	canRun: boolean;
}) {
	const routines = useRoutines(agent.id);
	const actions = useRoutineActions(agent.id);
	const [editing, setEditing] = useState<Routine | "new" | null>(null);
	const [deleting, setDeleting] = useState<Routine | null>(null);
	const [credential, setCredential] = useState<{ routineId: string; secret: string } | null>(null);

	if (routines.isPending) {
		return <p className="m-0 text-muted-foreground text-sm">Loading Routines...</p>;
	}
	if (routines.isError) return <Alert>{failureMessage(routines.error)}</Alert>;
	const definitions = routines.data ?? [];
	const closeEditor = () => {
		actions.preview.reset();
		actions.rotateSecret.reset();
		setEditing(null);
	};
	const editRoutine = (routine: Routine | "new") => {
		actions.create.reset();
		actions.update.reset();
		actions.preview.reset();
		actions.rotateSecret.reset();
		setEditing(routine);
	};

	return (
		<section className="flex flex-col gap-[18px]">
			<header className="flex flex-col items-start justify-between gap-4 sm:flex-row">
				<div className="min-w-0">
					<h3 className="m-0 font-display font-semibold text-heading text-lg">Routines</h3>
					<p className="mt-1 mb-0 text-muted-foreground text-sm leading-relaxed">
						Repeatable work for this agent. Each run starts a fresh thread in its Chat.
					</p>
				</div>
				{canManage && (
					<Button className="h-10 rounded-[10px] px-3.5 sm:h-9" onClick={() => editRoutine("new")}>
						<Plus /> New routine
					</Button>
				)}
			</header>

			{definitions.length === 0 ? (
				<div className="rounded-[14px] border border-border-subtle border-dashed bg-sunken px-5 py-8">
					<p className="m-0 font-medium text-heading">No recurring work yet.</p>
					<p className="mt-1 mb-0 text-muted-foreground text-sm">
						Start with a schedule or an authenticated webhook. You can test either with Run now.
					</p>
				</div>
			) : (
				<div className="overflow-hidden rounded-[14px] border border-border-subtle bg-card">
					<div className="hidden grid-cols-[34px_minmax(140px,1fr)_170px_186px_150px] items-center gap-3.5 border-border-subtle border-b bg-muted px-[18px] py-[9px] font-semibold text-[10.5px] text-subtle-foreground uppercase tracking-[0.08em] md:grid">
						<span aria-hidden />
						<span>Routine</span>
						<span>Schedule</span>
						<span>Last run</span>
						<span aria-hidden />
					</div>
					{definitions.map((routine) => (
						<RoutineRow
							key={routine.id}
							agent={agent}
							routine={routine}
							canManage={canManage}
							canRun={canRun}
							onEdit={() => editRoutine(routine)}
							onDelete={() => setDeleting(routine)}
						/>
					))}
				</div>
			)}

			<Dialog open={editing !== null} onOpenChange={(open) => !open && closeEditor()}>
				{editing && (
					<RoutineEditor
						key={editing === "new" ? "new" : editing.id}
						routine={editing === "new" ? undefined : editing}
						actions={actions}
						onSaved={(result) => {
							closeEditor();
							if (result.secret)
								setCredential({ routineId: result.routine.id, secret: result.secret });
						}}
						onSecret={(routineId, secret) => setCredential({ routineId, secret })}
						onCancel={closeEditor}
					/>
				)}
			</Dialog>

			<DeleteDialog
				open={deleting !== null}
				onOpenChange={(open) => !open && setDeleting(null)}
				title={`Delete ${deleting?.name ?? "Routine"}?`}
				description="Queued runs will be cancelled. Active work may finish, and completed history stays readable."
				pending={actions.remove.isPending}
				error={actions.remove.error ? failureMessage(actions.remove.error) : undefined}
				onDelete={async () => {
					if (!deleting) return;
					await actions.remove.mutateAsync(deleting.id);
					setDeleting(null);
				}}
			/>

			<SecretDialog credential={credential} onClose={() => setCredential(null)} />
		</section>
	);
}

function RoutineRow({
	agent,
	routine,
	canManage,
	canRun,
	onEdit,
	onDelete,
}: {
	agent: Agent;
	routine: Routine;
	canManage: boolean;
	canRun: boolean;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const executions = useRoutineExecutions(agent.id, routine.id);
	const actions = useRoutineActions(agent.id);
	const [runRequested, setRunRequested] = useState(false);
	const latest = executions.data?.items[0];
	const latestId = latest?.id;
	const Icon = routine.trigger.kind === "cron" ? AlarmClock : Webhook;
	const busy = actions.run.isPending || actions.update.isPending;
	const actionError = actions.run.error ?? actions.update.error;
	const paused = routine.state === "paused";

	useEffect(() => {
		if (latestId) setRunRequested(false);
	}, [latestId]);

	const resetActionErrors = () => {
		actions.run.reset();
		actions.update.reset();
	};

	function setEnabled(enabled: boolean) {
		resetActionErrors();
		actions.update.mutate({
			routineId: routine.id,
			json: { state: enabled ? "enabled" : "paused" },
		});
	}

	function runNow() {
		resetActionErrors();
		setRunRequested(true);
		actions.run.mutate(routine.id, { onError: () => setRunRequested(false) });
	}

	return (
		<div
			className={`grid grid-cols-[34px_minmax(0,1fr)] items-center gap-x-3.5 gap-y-3 border-border-subtle border-b px-[18px] py-[15px] last:border-b-0 md:grid-cols-[34px_minmax(140px,1fr)_170px_186px_150px] ${paused ? "bg-muted/55" : "bg-card"}`}
		>
			<span
				className={`flex size-[34px] items-center justify-center rounded-[11px] ${paused ? "bg-muted text-subtle-foreground" : "bg-primary-tint text-primary-tint-foreground"}`}
			>
				<Icon aria-hidden className="size-4" />
			</span>
			<div className="min-w-0">
				<p
					className={`m-0 truncate font-semibold text-base ${paused ? "text-muted-foreground" : "text-heading"}`}
				>
					{routine.name}
				</p>
			</div>
			<div className="col-start-2 flex min-w-0 flex-col gap-0.5 md:col-start-auto">
				<span
					className={`font-medium text-sm ${paused ? "text-muted-foreground" : "text-foreground"}`}
				>
					{scheduleLabel(routine)}
				</span>
				<span className="text-subtle-foreground text-xs">
					{paused
						? `Paused ${formatShortDate(routine.updatedAt)}`
						: routine.trigger.kind === "cron" && routine.trigger.nextScheduledAt
							? `Next ${formatShortDate(routine.trigger.nextScheduledAt, routine.trigger.timezone)}`
							: routine.trigger.kind === "webhook"
								? "Runs when called"
								: "No run scheduled"}
				</span>
			</div>
			<div className="col-start-2 min-w-0 md:col-start-auto">
				<LastRun agent={agent} execution={latest} optimistic={runRequested} />
			</div>
			{(canManage || canRun) && (
				<div className="col-start-2 flex items-center justify-start gap-2 md:col-start-auto md:justify-end">
					{/* Resuming a paused Routine changes it, so it needs `manageRoutines`;
					    starting one that is already running needs only `runRoutines`. */}
					{(paused ? canManage : canRun) && (
						<Button
							variant="outline"
							size="sm"
							className="h-10 rounded-[9px] px-3 md:h-[30px]"
							disabled={busy}
							onClick={() => (paused ? setEnabled(true) : runNow())}
						>
							<Play className="fill-current" /> {paused ? "Resume" : "Run now"}
						</Button>
					)}
					{canManage && (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<IconButton
										label={`${routine.name} options`}
										variant="outline"
										size="lg"
										className="size-10 md:size-[30px]"
										disabled={busy}
									>
										<Ellipsis />
									</IconButton>
								}
							/>
							<DropdownMenuContent align="end" className="min-w-36">
								<DropdownMenuItem onClick={() => setEnabled(paused)}>
									{paused ? <Play /> : <Pause />}
									{paused ? "Resume" : "Pause"}
								</DropdownMenuItem>
								<DropdownMenuItem onClick={onEdit}>
									<Pencil /> Edit
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem variant="destructive" onClick={onDelete}>
									<Trash2 /> Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			)}
			{actionError && (
				<Alert className="col-span-full mt-1 mb-0 text-sm">{failureMessage(actionError)}</Alert>
			)}
		</div>
	);
}

function LastRun({
	agent,
	execution,
	optimistic,
}: {
	agent: Agent;
	execution?: RoutineExecution;
	optimistic: boolean;
}) {
	if (!execution && !optimistic) {
		return <span className="text-subtle-foreground text-sm">Not run yet</span>;
	}
	const state = optimistic ? "running" : execution?.state;
	const presentation = executionStatePresentation(state);
	const Icon = presentation.icon;
	const content = (
		<>
			<span className={`flex items-center gap-1.5 font-medium text-sm ${presentation.className}`}>
				<Icon aria-hidden className={`size-3.5 ${state === "running" ? "animate-spin" : ""}`} />
				{presentation.label}
			</span>
			{execution && (
				<span className="mt-0.5 block text-subtle-foreground text-xs">
					{formatShortDate(execution.acceptedAt)}
					{executionDuration(execution)}
				</span>
			)}
		</>
	);
	if (!execution) return <div>{content}</div>;
	return (
		<Link
			to="/agents/$agent"
			params={{ agent: agent.id }}
			search={{ pod: agent.podId, thread: execution.threadId, history: "open" }}
			className="block rounded-sm focus-ring"
		>
			{content}
		</Link>
	);
}

function RoutineEditor({
	routine,
	actions,
	onSaved,
	onSecret,
	onCancel,
}: {
	routine?: Routine;
	actions: ReturnType<typeof useRoutineActions>;
	onSaved: (result: { routine: Routine; secret: string | null }) => void;
	onSecret: (routineId: string, secret: string) => void;
	onCancel: () => void;
}) {
	const prefix = useId();
	const initialSchedule = scheduleDraft(routine);
	const [name, setName] = useState(routine?.name ?? "");
	const [instructions, setInstructions] = useState(routine?.instructions ?? "");
	const [kind, setKind] = useState<"cron" | "webhook">(routine?.trigger.kind ?? "cron");
	const [preset, setPreset] = useState(initialSchedule.preset);
	const [days, setDays] = useState(initialSchedule.days);
	const [time, setTime] = useState(initialSchedule.time);
	const [resetConfirmation, setResetConfirmation] = useState("");
	const timezone =
		routine?.trigger.kind === "cron"
			? routine.trigger.timezone
			: Intl.DateTimeFormat().resolvedOptions().timeZone;
	const expression =
		preset === "custom" ? initialSchedule.expression : cronExpression({ preset, days, time });
	const pending = actions.create.isPending || actions.update.isPending;
	const previewMatchesInput =
		actions.preview.variables?.expression === expression &&
		actions.preview.variables.timezone === timezone;
	const preview = previewMatchesInput ? actions.preview.data : undefined;
	const previewError = kind === "cron" && previewMatchesInput ? actions.preview.error : null;
	const error = actions.create.error ?? actions.update.error ?? previewError;
	const resetArmed =
		name.trim() !== "" &&
		resetConfirmation.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase();
	const hasDays = preset !== "specific" || days.length > 0;

	useEffect(() => {
		if (kind !== "cron" || preset === "custom" || !hasDays || !expression) return;
		const timer = window.setTimeout(() => actions.preview.mutate({ expression, timezone }), 250);
		return () => window.clearTimeout(timer);
	}, [actions.preview.mutate, expression, hasDays, kind, preset, timezone]);

	async function save() {
		const input: NewRoutine =
			kind === "cron"
				? {
						name,
						instructions,
						state: routine?.state ?? "enabled",
						trigger: { kind: "cron", expression, timezone },
					}
				: {
						name,
						instructions,
						state: routine?.state ?? "enabled",
						trigger: { kind: "webhook" },
					};
		try {
			const result = routine
				? await actions.update.mutateAsync({ routineId: routine.id, json: input as RoutineUpdate })
				: await actions.create.mutateAsync(input);
			onSaved(result);
		} catch {
			return;
		}
	}

	async function resetSecret() {
		if (!routine || !resetArmed) return;
		try {
			const result = await actions.rotateSecret.mutateAsync(routine.id);
			setResetConfirmation("");
			onSecret(routine.id, result.secret);
		} catch {
			return;
		}
	}

	return (
		<DialogForm
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<DialogFormBody>
				<DialogHeader className="gap-1">
					<DialogTitle className="text-lg">{routine ? "Edit routine" : "New routine"}</DialogTitle>
					<DialogDescription>
						Instructions are snapshotted when each trigger is accepted.
					</DialogDescription>
				</DialogHeader>
				{error && <Alert>{failureMessage(error)}</Alert>}
				<Field id={`${prefix}-name`} label="Name">
					<Input
						id={`${prefix}-name`}
						className="h-10 rounded-[10px] px-3 font-medium text-base"
						value={name}
						onChange={(event) => setName(event.target.value)}
						maxLength={80}
						required
					/>
				</Field>
				<div className="flex flex-col gap-2">
					<div className="flex items-baseline justify-between gap-3">
						<label
							htmlFor={`${prefix}-instructions`}
							className="font-semibold text-foreground text-sm"
						>
							Instructions
						</label>
						<span className="text-subtle-foreground text-xs">Markdown supported</span>
					</div>
					<Textarea
						id={`${prefix}-instructions`}
						className="min-h-[86px] rounded-[10px] px-3 py-2.5 text-base leading-relaxed"
						value={instructions}
						onChange={(event) => setInstructions(event.target.value)}
						maxLength={20_000}
						required
					/>
				</div>
				<fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
					<legend className="mb-2 font-semibold text-foreground text-sm">Trigger</legend>
					<div className="flex gap-2">
						<TriggerChoice
							checked={kind === "webhook"}
							label="Webhook"
							icon={Webhook}
							onClick={() => {
								actions.preview.reset();
								setKind("webhook");
							}}
						/>
						<TriggerChoice
							checked={kind === "cron"}
							label="Schedule"
							icon={AlarmClock}
							onClick={() => setKind("cron")}
						/>
					</div>
				</fieldset>

				{kind === "webhook" ? (
					<WebhookEditor
						routine={routine}
						name={name}
						confirmation={resetConfirmation}
						resetArmed={resetArmed}
						resetPending={actions.rotateSecret.isPending}
						resetError={actions.rotateSecret.error}
						onConfirmationChange={setResetConfirmation}
						onReset={() => void resetSecret()}
					/>
				) : (
					<ScheduleEditor
						preset={preset}
						days={days}
						time={time}
						expression={expression}
						nextRun={preview?.[0]}
						timezone={timezone}
						onPresetChange={setPreset}
						onDaysChange={setDays}
						onTimeChange={setTime}
					/>
				)}
			</DialogFormBody>
			<DialogFormFooter>
				<Button
					type="button"
					variant="outline"
					className="h-9 rounded-[10px] px-4"
					disabled={pending}
					onClick={onCancel}
				>
					Cancel
				</Button>
				<Button
					type="submit"
					className="h-9 rounded-[10px] px-4"
					disabled={pending || !name.trim() || !instructions.trim() || !hasDays}
				>
					Save routine
				</Button>
			</DialogFormFooter>
		</DialogForm>
	);
}

function TriggerChoice({
	checked,
	label,
	icon: Icon,
	onClick,
}: {
	checked: boolean;
	label: string;
	icon: typeof Webhook;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={checked}
			onClick={onClick}
			className={`focus-ring inline-flex cursor-pointer items-center gap-2 rounded-[9px] border px-3 py-2 text-sm ${checked ? "border-primary-tint-border bg-primary-tint font-semibold text-heading" : "border-border bg-card font-medium text-muted-foreground hover:bg-muted"}`}
		>
			<Icon
				aria-hidden
				className={`size-3.5 ${checked ? "text-primary" : "text-subtle-foreground"}`}
			/>
			{label}
		</button>
	);
}

function WebhookEditor({
	routine,
	name,
	confirmation,
	resetArmed,
	resetPending,
	resetError,
	onConfirmationChange,
	onReset,
}: {
	routine?: Routine;
	name: string;
	confirmation: string;
	resetArmed: boolean;
	resetPending: boolean;
	resetError: unknown;
	onConfirmationChange: (value: string) => void;
	onReset: () => void;
}) {
	if (!routine) {
		return (
			<div className="border-border-subtle border-t pt-[18px]">
				<p className="m-0 text-muted-foreground text-sm leading-relaxed">
					The endpoint and signing secret will be created when you save. The secret is shown once.
				</p>
			</div>
		);
	}
	const endpoint = webhookUrl(routine.id);
	return (
		<div className="flex flex-col gap-3 border-border-subtle border-t pt-[18px]">
			<div className="flex flex-col gap-2">
				<span className="font-semibold text-foreground text-sm">Endpoint</span>
				<div className="flex items-center gap-2 rounded-[10px] border border-border bg-muted px-3 py-2">
					<code className="min-w-0 flex-1 truncate text-foreground text-xs">{endpoint}</code>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-7 rounded-md"
						onClick={() => void navigator.clipboard.writeText(endpoint)}
					>
						<Copy /> Copy
					</Button>
				</div>
			</div>
			<div className="flex flex-col gap-3 rounded-[10px] border border-border bg-muted p-3">
				<div className="flex items-start gap-2.5">
					<LockKeyhole aria-hidden className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground" />
					<div>
						<p className="m-0 font-medium text-heading text-sm">Reset signing secret</p>
						<p className="mt-1 mb-0 text-muted-foreground text-xs leading-relaxed">
							The new secret is shown once and never again. The current one stops working the moment
							you reset; update every caller first.
						</p>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Input
						aria-label="Confirm secret reset"
						value={confirmation}
						onChange={(event) => onConfirmationChange(event.target.value)}
						placeholder={`Type ${name || "the routine name"} to confirm`}
						className="h-9 min-w-0 flex-1 rounded-[9px] px-3 text-sm"
					/>
					<Button
						type="button"
						variant="destructive"
						className="h-9 rounded-[9px] px-3"
						disabled={!resetArmed || resetPending}
						onClick={onReset}
					>
						Reset
					</Button>
				</div>
				<p className="m-0 text-subtle-foreground text-xs leading-relaxed">
					{resetArmed ? "Armed; resetting" : "Resetting"} happens on click. It does not wait for
					Save routine and cannot be undone.
				</p>
				{resetError !== null && resetError !== undefined && (
					<Alert className="mb-0 text-sm">{failureMessage(resetError)}</Alert>
				)}
			</div>
		</div>
	);
}

function ScheduleEditor({
	preset,
	days,
	time,
	expression,
	nextRun,
	timezone,
	onPresetChange,
	onDaysChange,
	onTimeChange,
}: {
	preset: SchedulePreset;
	days: string[];
	time: string;
	expression: string;
	nextRun?: string;
	timezone: string;
	onPresetChange: (preset: SchedulePreset) => void;
	onDaysChange: (days: string[]) => void;
	onTimeChange: (time: string) => void;
}) {
	return (
		<div className="flex flex-col gap-3 border-border-subtle border-t pt-[18px]">
			<span className="font-semibold text-foreground text-sm">Repeats</span>
			<div className="flex flex-wrap gap-1.5">
				{preset === "custom" && (
					<button
						type="button"
						aria-pressed
						className="focus-ring cursor-pointer rounded-full border border-primary-tint-border bg-primary-tint px-3 py-1 font-semibold text-heading text-sm"
					>
						Custom cron
					</button>
				)}
				{SCHEDULE_PRESETS.map((option) => (
					<button
						key={option.value}
						type="button"
						aria-pressed={preset === option.value}
						onClick={() => onPresetChange(option.value)}
						className={`focus-ring cursor-pointer rounded-full border px-3 py-1 text-sm ${preset === option.value ? "border-primary-tint-border bg-primary-tint font-semibold text-heading" : "border-border bg-card font-medium text-muted-foreground hover:bg-muted"}`}
					>
						{option.label}
					</button>
				))}
			</div>
			{preset === "custom" ? (
				<div className="rounded-[10px] border border-border bg-muted px-3 py-2.5">
					<code className="text-foreground text-xs">{expression}</code>
					<p className="mt-1.5 mb-0 text-muted-foreground text-xs leading-relaxed">
						Choose a preset to replace this custom schedule.
					</p>
				</div>
			) : (
				<>
					{preset === "specific" && (
						<fieldset className="m-0 grid min-w-0 grid-cols-7 gap-1.5 border-0 p-0">
							<legend className="sr-only">Days of the week</legend>
							{DAY_OPTIONS.map((day) => {
								const selected = days.includes(day.cron);
								return (
									<button
										key={day.cron}
										type="button"
										aria-pressed={selected}
										onClick={() =>
											onDaysChange(
												selected ? days.filter((value) => value !== day.cron) : [...days, day.cron],
											)
										}
										className={`focus-ring cursor-pointer rounded-[9px] border py-2 text-xs ${selected ? "border-primary bg-primary font-semibold text-primary-foreground" : day.cron === "0" || day.cron === "6" ? "border-border-subtle bg-card font-medium text-subtle-foreground" : "border-border bg-card font-medium text-muted-foreground"}`}
									>
										{day.short}
									</button>
								);
							})}
						</fieldset>
					)}
					<div className="flex items-center gap-2">
						<span className="text-muted-foreground text-sm">
							{preset === "hourly" ? "from" : "at"}
						</span>
						<Input
							type="time"
							step={300}
							value={time}
							onChange={(event) => event.target.value && onTimeChange(event.target.value)}
							aria-label="Run time"
							className="h-9 w-auto rounded-[9px] px-3 text-sm"
						/>
					</div>
					<div className="flex flex-col gap-1 border-border-subtle border-t pt-3">
						<span className="font-medium text-heading text-sm">
							{scheduleSummary(preset, days, time)}
						</span>
						<span className="text-subtle-foreground text-xs">
							{days.length === 0 && preset === "specific"
								? "No runs scheduled yet."
								: nextRun
									? `Next run ${formatShortDate(nextRun, timezone)}`
									: "Calculating the next run..."}
						</span>
					</div>
				</>
			)}
		</div>
	);
}

function SecretDialog({
	credential,
	onClose,
}: {
	credential: { routineId: string; secret: string } | null;
	onClose: () => void;
}) {
	const url = credential ? webhookUrl(credential.routineId) : "";
	return (
		<Dialog open={credential !== null} onOpenChange={(open) => !open && onClose()}>
			{credential && (
				<DialogForm
					onSubmit={(event) => {
						event.preventDefault();
						onClose();
					}}
				>
					<DialogFormBody>
						<DialogHeader className="gap-1">
							<DialogTitle className="text-lg">Webhook credential</DialogTitle>
							<DialogDescription>
								This signing secret is shown once. Store it before closing.
							</DialogDescription>
						</DialogHeader>
						<CredentialLine label="Endpoint" value={url} />
						<CredentialLine label="Bearer secret" value={credential.secret} />
					</DialogFormBody>
					<DialogFormFooter>
						<Button type="submit" className="h-9 rounded-[10px] px-4">
							I stored it
						</Button>
					</DialogFormFooter>
				</DialogForm>
			)}
		</Dialog>
	);
}

function CredentialLine({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col gap-2">
			<span className="font-semibold text-foreground text-sm">{label}</span>
			<div className="flex items-center gap-2 rounded-[10px] border border-border bg-muted p-2.5">
				<code className="min-w-0 flex-1 break-all text-xs">{value}</code>
				<IconButton
					label={`Copy ${label}`}
					variant="outline"
					onClick={() => void navigator.clipboard.writeText(value)}
				>
					<Copy />
				</IconButton>
			</div>
		</div>
	);
}

function scheduleDraft(routine?: Routine): ScheduleDraft {
	if (routine?.trigger.kind !== "cron") {
		return { preset: "weekdays", days: ["1", "2", "3", "4", "5"], time: "09:00", expression: "" };
	}
	const expression = routine.trigger.expression.trim();
	const [minute, hour, dayOfMonth, month, dayOfWeek] = expression.split(/\s+/);
	if (!minute || !hour || dayOfMonth !== "*" || month !== "*" || !dayOfWeek) {
		return { preset: "custom", days: [], time: "09:00", expression };
	}
	if (/^\d+$/.test(minute) && /^\d+-23$/.test(hour) && dayOfWeek === "*") {
		return {
			preset: "hourly",
			days: [],
			time: `${hour.split("-")[0]?.padStart(2, "0")}:${minute.padStart(2, "0")}`,
			expression,
		};
	}
	if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) {
		return { preset: "custom", days: [], time: "09:00", expression };
	}
	const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
	if (dayOfWeek === "*") return { preset: "daily", days: [], time, expression };
	if (dayOfWeek === "1-5") {
		return { preset: "weekdays", days: ["1", "2", "3", "4", "5"], time, expression };
	}
	const days = dayOfWeek.split(",").map((day) => (day === "7" ? "0" : day));
	if (days.every((day) => DAY_OPTIONS.some((option) => option.cron === day))) {
		return { preset: "specific", days, time, expression };
	}
	return { preset: "custom", days: [], time, expression };
}

function cronExpression({ preset, days, time }: Omit<ScheduleDraft, "expression">): string {
	const [hour = "9", minute = "0"] = time.split(":");
	if (preset === "hourly") return `${Number(minute)} ${Number(hour)}-23 * * *`;
	if (preset === "daily") return `${Number(minute)} ${Number(hour)} * * *`;
	if (preset === "weekdays") return `${Number(minute)} ${Number(hour)} * * 1-5`;
	return `${Number(minute)} ${Number(hour)} * * ${orderedDays(days).join(",")}`;
}

function scheduleLabel(routine: Routine): string {
	if (routine.trigger.kind === "webhook") return "On webhook";
	const draft = scheduleDraft(routine);
	return draft.preset === "custom"
		? "Custom schedule"
		: scheduleSummary(draft.preset, draft.days, draft.time);
}

function scheduleSummary(
	preset: Exclude<SchedulePreset, "custom">,
	days: string[],
	time: string,
): string;
function scheduleSummary(preset: SchedulePreset, days: string[], time: string): string {
	const formattedTime = formatTime(time);
	if (preset === "hourly") return `Every hour from ${formattedTime}`;
	if (preset === "daily") return `Every day at ${formattedTime}`;
	if (preset === "weekdays") return `Every weekday at ${formattedTime}`;
	if (preset === "custom") return "Custom schedule";
	const selected = orderedDays(days).map(
		(value) => DAY_OPTIONS.find((day) => day.cron === value)?.long,
	);
	return selected.length === 0
		? "Pick at least one day"
		: `${selected.join(", ")} at ${formattedTime}`;
}

function orderedDays(days: string[]): string[] {
	return DAY_OPTIONS.map((day) => day.cron).filter((day) => days.includes(day));
}

function formatTime(value: string): string {
	const [hour = 0, minute = 0] = value.split(":").map(Number);
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
		.format(new Date(2000, 0, 1, hour, minute))
		.toLocaleLowerCase();
}

function formatShortDate(value: string, timeZone?: string): string {
	return new Intl.DateTimeFormat(undefined, {
		day: "numeric",
		month: "short",
		hour: "numeric",
		minute: "2-digit",
		timeZone,
	}).format(new Date(value));
}

function executionDuration(execution: RoutineExecution): string {
	if (!execution.startedAt || !execution.finishedAt) return "";
	const durationSeconds = Math.max(
		0,
		Math.round(
			(new Date(execution.finishedAt).getTime() - new Date(execution.startedAt).getTime()) / 1_000,
		),
	);
	return ` · ${durationSeconds}s`;
}

function executionStatePresentation(state: RoutineExecution["state"] | undefined) {
	switch (state) {
		case "completed":
			return { label: "Completed", icon: Check, className: "text-primary" };
		case "failed":
			return { label: "Failed", icon: CircleAlert, className: "text-destructive" };
		case "cancelled":
			return { label: "Cancelled", icon: Ban, className: "text-muted-foreground" };
		case "queued":
			return { label: "Queued", icon: Clock3, className: "text-muted-foreground" };
		default:
			return { label: "Running", icon: RefreshCw, className: "text-primary" };
	}
}

function webhookUrl(routineId: string): string {
	return `${apiBaseUrl}/hooks/routines/${routineId}`;
}
