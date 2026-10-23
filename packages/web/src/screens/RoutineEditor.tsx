import {
	type Agent,
	deliveryIdHeaderOf,
	MAX_ROUTINE_INSTRUCTIONS_CHARACTERS,
	MAX_ROUTINE_NAME_CHARACTERS,
	type NewRoutine,
	type Pod,
	type Routine,
	type RoutineResults,
	type RoutineTrigger,
	type RoutineTriggerInput,
} from "@sugabots/contracts";
import { cn } from "cn";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useChatList } from "@/lib/chats.ts";
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
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import {
	PageBackLink,
	SettingsControlRow,
	SettingsFieldLabel,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import type { TriggerKind } from "./RoutineTriggerKinds.tsx";
import {
	TriggerDialog,
	type TriggerDraft,
	TriggersGroup,
	triggerDraftOf,
	triggerInputOf,
} from "./RoutineTriggers.tsx";

/** A bot a routine can belong to, with the pod it lives in. */
export interface BotChoice {
	agent: Agent;
	pod: Pod;
}

/** A routine with the bot it belongs to and that bot's pod. */
export interface PlacedRoutine extends BotChoice {
	routine: Routine;
}

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
	/** The bot it is for, when it was begun from that bot's routines, which then can't be changed. */
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
	// Null for the pod's first chat.
	const [chatId, setChatId] = useState<string | null>(null);
	const [page, setPage] = useState<RoutineSubpage>("routine");
	const actions = useRoutineActions();
	const bot = choices.find((choice) => choice.agent.id === agentId);
	const inputs = triggers.flatMap(({ draft }) => {
		const written = triggerInputOf(draft);
		return "input" in written ? [written.input] : [];
	});
	const results = chosenResults ?? DEFAULT_RESULTS[inputs[0]?.kind ?? "cron"];
	const ready = bot !== undefined && name.trim() !== "" && instructions.trim() !== "";
	// Begun from one bot's routines, it can only be that bot's.
	const botFixed = choices.some((choice) => choice.agent.id === initialAgentId);
	const editing = triggers.find((one) => one.key === open);

	async function create() {
		if (!bot || !ready) return;
		try {
			const created = await actions.create.mutateAsync({
				agentId: bot.agent.id,
				json: {
					name,
					instructions,
					results,
					...(results === "post_to_chat" && chatId !== null && { chatId }),
					triggers: inputs,
				},
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
			description={
				botFixed && bot
					? `Something ${bot.agent.name} does without being asked. Set it up, then create it.`
					: "Set it up, then create it."
			}
		>
			<SettingsGroup>
				<NameInputRow value={name} onChange={setName} />
				{botFixed && bot ? (
					// Begun from this bot's routines, so it is this bot's.
					<SettingsRow label="Bot" trailing={<SettingsValue>{bot.agent.name}</SettingsValue>} />
				) : (
					<BotRow
						chosen={bot}
						choices={choices}
						onChoose={(chosen) => {
							setAgentId(chosen);
							// Another bot's pod may not have the repositories its triggers watch.
							setTriggers((current) => current.filter(({ draft }) => draft.kind !== "github"));
						}}
					/>
				)}
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
				{results === "post_to_chat" && bot && (
					<ChatRow pod={bot.pod} chatId={chatId} onChange={setChatId} />
				)}
			</SettingsGroup>
			{actions.create.error && <Alert>{failureMessage(actions.create.error)}</Alert>}
			{/* At the foot, once it has been set up, where a form ends. */}
			<div className="flex justify-end gap-2">
				<Button variant="secondary" onClick={onCancel} disabled={actions.create.isPending}>
					Cancel
				</Button>
				<Button onClick={() => void create()} disabled={!ready || actions.create.isPending}>
					Create routine
				</Button>
			</div>
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

 * A copy of the routine on the same bot, paused so the two don't both run.
 * A webhook copy has its own address and a new secret, so a secret its
 * sender made has to be pasted into it again. A repository copy runs on the
 * same repository and events.
 */
export function copyOf(routine: Routine, siblingNames: readonly string[]): NewRoutine {
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
			return { kind: "webhook", auth: trigger.auth, deliveryIdHeader: deliveryIdHeaderOf(trigger) };
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
				className="min-w-0 flex-1 rounded-md bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:shadow-(--ring-shadow)"
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
			<span className="truncate text-[13px] text-foreground">{chosen.agent.name}</span>
			<span className="truncate text-muted-foreground text-sm">{chosen.pod.name}</span>
		</span>
	) : (
		<span className="flex-1 text-[13px] text-muted-foreground">Choose a bot</span>
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
				className="focus-ring flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-settings-row-hover active:bg-row-selected"
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
											<span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
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

const countFormat = new Intl.NumberFormat("en");

/** The note under a routine's instructions while they are written: what to say, and how much room is left. */
export function instructionsNote(instructions: string): string {
	return `Say what to look at, what to do, and what a good result looks like. ${countFormat.format(instructions.length)} of ${countFormat.format(MAX_ROUTINE_INSTRUCTIONS_CHARACTERS)} characters.`;
}

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
			backOnWide
			title="Instructions"
			description={`What ${botName ?? "the bot"} does each time this runs.`}
		>
			{error && <Alert>{error}</Alert>}
			<SettingsGroup className="p-1" note={editable ? instructionsNote(value) : undefined}>
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
					className="block min-h-[380px] w-full resize-y rounded-[12px] bg-transparent p-3.5 text-[13px] text-foreground leading-[1.65] outline-none placeholder:text-subtle-foreground focus-visible:shadow-(--ring-shadow)"
				/>
			</SettingsGroup>
			{editable && <div className="flex justify-end">{action}</div>}
		</SettingsPage>
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
			label="Also post result in the pod's channel"
			checked={results === "post_to_chat"}
			onChange={(posted) => onChange(posted ? "post_to_chat" : "keep_in_run")}
		/>
	);
}

/**
 * Which of the pod's chats a routine's results go to, offered once the pod
 * has more than one: its first, which a null `chatId` stands for, or another.
 */
export function ChatRow({
	pod,
	chatId,
	onChange,
}: {
	pod: Pod;
	chatId: string | null;
	onChange: (chatId: string | null) => void;
}) {
	const chats = useChatList(pod.kind === "shared" ? pod.slug : undefined).data?.chats ?? [];
	if (chats.length < 2) return null;
	const chosen =
		chats.find(({ conversation }) => conversation.id === chatId) ??
		chats.find(({ conversation }) => conversation.main);
	const name = chosen?.conversation.title ?? "";
	return (
		<SettingsControlRow label="Chat">
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label={`Chat: ${name}`}
					className="focus-ring ml-auto flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-[8px] bg-chip px-2.5 text-[14px] text-foreground transition-colors hover:bg-hover"
				>
					<span className="truncate">{name}</span>
					<ChevronDown aria-hidden size={14} className="shrink-0 text-muted-foreground" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-48">
					<DropdownMenuRadioGroup
						value={chosen?.conversation.id}
						onValueChange={(id: string) =>
							onChange(
								chats.find(({ conversation }) => conversation.id === id)?.conversation.main
									? null
									: id,
							)
						}
					>
						{chats.map(({ conversation }) => (
							<DropdownMenuRadioItem key={conversation.id} value={conversation.id}>
								{conversation.title}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</SettingsControlRow>
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
		<div className="flex min-h-14 items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0">
			<span className="flex-1 text-[13px] text-foreground">{label}</span>
			<Toggle label={label} checked={checked} disabled={disabled} onChange={onChange} />
		</div>
	);
}

export function DeleteRoutine({
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
