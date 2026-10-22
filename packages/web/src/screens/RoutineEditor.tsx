import {
	type Agent,
	MAX_ROUTINE_INSTRUCTIONS_CHARACTERS,
	MAX_ROUTINE_NAME_CHARACTERS,
	type NewRoutine,
	type Pod,
	type Routine,
	type RoutineResults,
	type RoutineTrigger,
	type RoutineTriggerInput,
	type RoutineUpdate,
} from "@sugabots/contracts";
import { cn } from "cn";
import { Check, ChevronRight, Copy, Ellipsis, Play, Trash2 } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { failureMessage } from "@/lib/failure.ts";
import { useRoutineActions } from "@/lib/routines.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import {
	PageBackLink,
	SettingsControlRow,
	SettingsFieldLabel,
	SettingsGroup,
	SettingsNameRow,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { RecentRuns } from "./RoutineRuns.tsx";
import type { TriggerKind } from "./RoutineTriggerKinds.tsx";
import {
	TriggerDialog,
	type TriggerDraft,
	TriggersGroup,
	triggerDraftOf,
	triggerInputOf,
} from "./RoutineTriggers.tsx";
import { WebhookGroups } from "./RoutineWebhook.tsx";

/** A bot a routine can belong to, with the pod it lives in. */
export interface BotChoice {
	agent: Agent;
	pod: Pod;
}

/** A routine with the bot it belongs to and that bot's pod. */
export interface PlacedRoutine extends BotChoice {
	routine: Routine;
}

/**
 * How long a schedule rests before it saves, so stepping the time through
 * several half hours saves once, where it stops.
 */
/** How long Run now says Starting… at least, so a quick start doesn't flash past unread. */
const STARTING_SHOWN_MS = 1000;

/** The page a routine shows: its own, or one of the parts that open from it. */
type RoutineSubpage = "routine" | "instructions";

/**
 * Where a new routine's result goes until someone chooses: a schedule is
 * usually something to read, such as a morning standup, and a webhook or a
 * repository's events usually work handled out of sight.
 */
const DEFAULT_RESULTS: Record<TriggerKind, RoutineResults> = {
	cron: "post_to_chat",
	webhook: "keep_in_run",
	github: "keep_in_run",
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
	const [triggers, setTriggers] = useState<readonly DraftedTrigger[]>([]);
	// The dialog open on a trigger, by its key, or on adding one.
	const [open, setOpen] = useState<string | "adding">();
	// Unset until chosen, so the result follows the first trigger's default.
	const [chosenResults, setChosenResults] = useState<RoutineResults>();
	const [page, setPage] = useState<RoutineSubpage>("routine");
	const actions = useRoutineActions();
	const bot = choices.find((choice) => choice.agent.id === agentId);
	const inputs = triggers.flatMap(({ draft }) => {
		const written = triggerInputOf(draft);
		return "input" in written ? [written.input] : [];
	});
	const results = chosenResults ?? DEFAULT_RESULTS[inputs[0]?.kind ?? "cron"];
	const ready = bot !== undefined && name.trim() !== "" && instructions.trim() !== "";
	const editing = triggers.find((one) => one.key === open);

	async function create() {
		if (!bot || !ready) return;
		try {
			const created = await actions.create.mutateAsync({
				agentId: bot.agent.id,
				json: { name, instructions, results, triggers: inputs },
			});
			onCreated(created.routine);
		} catch {
			// The page shows the error.
		}
	}

	const back = () => setPage("routine");
	const backLink = (
		<PageBackLink
			label={name.trim() || "New routine"}
			render={<button type="button" onClick={back} />}
		/>
	);
	if (page === "instructions") {
		return (
			<InstructionsPage
				back={backLink}
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
				<BotRow
					chosen={bot}
					choices={choices}
					onChoose={(chosen) => {
						setAgentId(chosen);
						// Another bot's pod may not have the repositories its triggers watch.
						setTriggers((current) => current.filter(({ draft }) => draft.kind !== "github"));
					}}
				/>
				<OpensRow
					label="Instructions"
					value={instructions.trim() === "" ? "Add" : "Edit"}
					onOpen={() => setPage("instructions")}
				/>
			</SettingsGroup>
			<TriggersGroup
				triggers={triggers.flatMap(({ key, draft }) => {
					const written = triggerInputOf(draft);
					return "input" in written ? [{ key, trigger: written.input }] : [];
				})}
				editable
				onOpen={setOpen}
				onAdd={() => setOpen("adding")}
			/>
			<SettingsGroup>
				<ResultsRow results={results} onChange={setChosenResults} />
			</SettingsGroup>
			<Dialog open={open !== undefined} onOpenChange={(opened) => !opened && setOpen(undefined)}>
				{open !== undefined && (
					<TriggerDialog
						pod={bot?.pod}
						editing={editing?.draft}
						onSave={async (input) => {
							const draft = triggerDraftOf(input);
							setTriggers((current) =>
								editing
									? current.map((one) => (one.key === editing.key ? { ...one, draft } : one))
									: [...current, { key: crypto.randomUUID(), draft }],
							);
						}}
						onRemove={
							editing
								? async () =>
										setTriggers((current) => current.filter((one) => one.key !== editing.key))
								: undefined
						}
						done={() => setOpen(undefined)}
					/>
				)}
			</Dialog>
		</SettingsPage>
	);
}

/** A trigger of a routine not made yet, by a key it keeps while it is changed. */
interface DraftedTrigger {
	key: string;
	draft: TriggerDraft;
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
	const [page, setPage] = useState<RoutineSubpage>("routine");
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	// The dialog open on a trigger, by its id, or on adding one.
	const [open, setOpen] = useState<string | "adding">();
	const { mutate: update, mutateAsync: updateAsync } = actions.update;
	const addressed = { agentId: agent.id, routineId: routine.id };
	const save = (json: RoutineUpdate) => update({ ...addressed, json });
	const editing = routine.triggers.find((trigger) => trigger.id === open);

	const backLink = (
		<PageBackLink
			label={routine.name}
			render={<button type="button" onClick={() => setPage("routine")} />}
		/>
	);
	if (page === "instructions") {
		return <RoutineInstructions placed={placed} back={backLink} />;
	}
	return (
		<SettingsPage
			title={routine.name}
			headerAction={
				<div className="flex gap-2">
					{pod.permissions.runRoutines && <RunNowButton placed={placed} />}
					{canManage && (
						<RoutineMenu
							pending={actions.create.isPending}
							onDuplicate={() =>
								actions.create
									.mutateAsync({ agentId: agent.id, json: copyOf(routine, siblingNames) })
									.then((created) => onDuplicated(created.routine))
									.catch(() => {})
							}
							onDelete={() => setConfirmingDelete(true)}
						/>
					)}
				</div>
			}
		>
			{actions.update.error && <Alert>{failureMessage(actions.update.error)}</Alert>}
			{actions.create.error && <Alert>{failureMessage(actions.create.error)}</Alert>}
			<SettingsGroup>
				<SwitchRow
					label="On"
					checked={routine.state === "enabled"}
					disabled={!canManage}
					onChange={(on) => save({ state: on ? "enabled" : "paused" })}
				/>
			</SettingsGroup>
			<SettingsGroup>
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
				<OpensRow
					label="Instructions"
					value={canManage ? "Edit" : "View"}
					onOpen={() => setPage("instructions")}
				/>
			</SettingsGroup>
			<TriggersGroup
				triggers={routine.triggers.map((trigger) => ({ key: trigger.id, trigger }))}
				editable={canManage}
				onOpen={setOpen}
				onAdd={() => setOpen("adding")}
			/>
			<SettingsGroup>
				<Editable editable={canManage}>
					<ResultsRow results={routine.results} onChange={(results) => save({ results })} />
				</Editable>
			</SettingsGroup>
			<Dialog open={open !== undefined} onOpenChange={(opened) => !opened && setOpen(undefined)}>
				{open !== undefined && (
					<TriggerDialog
						pod={pod}
						editing={editing && triggerDraftOf(editing)}
						settings={
							editing?.kind === "webhook" ? (
								<WebhookGroups
									placed={placed}
									triggerId={editing.id}
									auth={editing.auth}
									onChangeAuth={(auth) =>
										actions.updateTrigger.mutate({
											...addressed,
											triggerId: editing.id,
											json: { kind: "webhook", auth },
										})
									}
								/>
							) : undefined
						}
						onSave={(json) =>
							editing
								? actions.updateTrigger.mutateAsync({ ...addressed, triggerId: editing.id, json })
								: actions.addTrigger.mutateAsync({ ...addressed, json })
						}
						onRemove={
							editing
								? () => actions.removeTrigger.mutateAsync({ ...addressed, triggerId: editing.id })
								: undefined
						}
						done={() => setOpen(undefined)}
					/>
				)}
			</Dialog>
			<RecentRuns placed={placed} />
			<DeleteRoutine
				placed={placed}
				open={confirmingDelete}
				onOpenChange={setConfirmingDelete}
				onDeleted={onDeleted}
			/>
		</SettingsPage>
	);
}

/** What else can be done with a routine, behind ⋯ beside Run now. */
function RoutineMenu({
	pending,
	onDuplicate,
	onDelete,
}: {
	/** While a copy is being made, so it is made once. */
	pending: boolean;
	onDuplicate: () => void;
	onDelete: () => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Button variant="secondary" size="icon" aria-label="More" />}>
				<Ellipsis aria-hidden />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-52">
				<DropdownMenuItem disabled={pending} onClick={onDuplicate}>
					<Copy aria-hidden size={16} />
					Duplicate
				</DropdownMenuItem>
				<DropdownMenuItem variant="destructive" onClick={onDelete}>
					<Trash2 aria-hidden size={16} />
					Delete routine
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * A copy of the routine on the same bot, paused so the two don't both run.
 * A webhook copy has its own address and a new secret, so a secret its
 * sender made has to be pasted into it again. A repository copy runs on the
 * same repository and events.
 */
function copyOf(routine: Routine, siblingNames: readonly string[]): NewRoutine {
	const fields = {
		name: copyName(routine.name, siblingNames),
		instructions: routine.instructions,
		results: routine.results,
		state: "paused" as const,
	};
	return { ...fields, triggers: routine.triggers.map(copiedTrigger) };
}

/** A trigger as a copy of its routine has it: a webhook gets its own address and secret. */
function copiedTrigger(trigger: RoutineTrigger): RoutineTriggerInput {
	switch (trigger.kind) {
		case "cron":
			return { kind: "cron", schedule: trigger.schedule, timezone: trigger.timezone };
		case "webhook":
			return { kind: "webhook", auth: trigger.auth };
		case "github":
			return {
				kind: "github",
				connectionId: trigger.connectionId,
				repository: trigger.repository,
				events: trigger.events,
			};
	}
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
			<AgentAvatar
				color={chosen.agent.color}
				face={chosen.agent.face}
				shape={chosen.agent.shape}
				size={24}
			/>
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
											<AgentAvatar
												color={agent.color}
												face={agent.face}
												shape={agent.shape}
												size={24}
											/>
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

/** A row that opens a page of its own, with its value at the end, as a bot's Model and Instructions do. */
function OpensRow({ label, value, onOpen }: { label: string; value: string; onOpen: () => void }) {
	return (
		<SettingsRow
			label={label}
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

function ResultsRow({
	results,
	onChange,
}: {
	results: RoutineResults;
	onChange: (results: RoutineResults) => void;
}) {
	return (
		<SwitchRow
			label="Also post result in the pod's chat"
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
