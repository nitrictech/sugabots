import {
	type Automation,
	type AutomationTrigger,
	type AutomationTriggerInput,
	type Bot,
	MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS,
	MAX_AUTOMATION_NAME_CHARACTERS,
	type NewAutomation,
} from "@sugabots/contracts";
import { cn } from "cn";
import { Check, ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useAutomationActions } from "@/lib/automations.ts";
import { failureMessage } from "@/lib/failure.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	PageBackLink,
	SettingsControlRow,
	SettingsFieldLabel,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import {
	TriggerDialog,
	type TriggerDraft,
	TriggersGroup,
	triggerDraftOf,
	triggerInputOf,
} from "./AutomationTriggers.tsx";

/** A bot an automation can belong to. */
export interface BotChoice {
	bot: Bot;
}

/** An automation with the bot it belongs to. */
export interface PlacedAutomation extends BotChoice {
	automation: Automation;
}

/** The page an automation shows: its own, or one of the parts that open from it. */
type AutomationSubpage = "automation" | "instructions";

/**
 * An automation being made. Nothing is saved until Create, which opens the new
 * automation's own page; a webhook's secret is made then, and shown there.
 */
export function NewAutomationPage({
	choices,
	initialBotId,
	onCancel,
	onCreated,
}: {
	/** The bots it may be made for, in the order the picker lists them. */
	choices: readonly BotChoice[];
	/** The bot it is for, when it was begun from that bot's automations, which then can't be changed. */
	initialBotId: string | undefined;
	onCancel: () => void;
	onCreated: (automation: Automation) => void;
}) {
	const [name, setName] = useState("");
	const [instructions, setInstructions] = useState("");
	const [botId, setBotId] = useState(
		choices.find((choice) => choice.bot.id === initialBotId)?.bot.id ?? choices[0]?.bot.id,
	);
	const [triggers, setTriggers] = useState<readonly DraftedTrigger[]>([]);
	// The dialog open on a trigger, by its key, or on adding one.
	const [open, setOpen] = useState<string | "adding">();
	const [page, setPage] = useState<AutomationSubpage>("automation");
	const actions = useAutomationActions();
	const bot = choices.find((choice) => choice.bot.id === botId);
	const inputs = triggers.flatMap(({ draft }) => {
		const written = triggerInputOf(draft);
		return "input" in written ? [written.input] : [];
	});
	const ready = bot !== undefined && name.trim() !== "" && instructions.trim() !== "";
	// Begun from one bot's automations, it can only be that bot's.
	const botFixed = choices.some((choice) => choice.bot.id === initialBotId);
	const editing = triggers.find((one) => one.key === open);

	async function create() {
		if (!bot || !ready) return;
		try {
			const created = await actions.create.mutateAsync({
				botId: bot.bot.id,
				json: {
					name,
					instructions,
					triggers: inputs,
				},
			});
			onCreated(created.automation);
		} catch {
			// The page shows the error.
		}
	}

	const back = () => setPage("automation");
	const backLink = (
		<PageBackLink
			label={name.trim() || "New automation"}
			render={<button type="button" onClick={back} />}
		/>
	);
	if (page === "instructions") {
		return (
			<InstructionsPage
				back={backLink}
				botName={bot?.bot.name}
				value={instructions}
				onChange={setInstructions}
				editable
				action={<Button onClick={back}>Done</Button>}
			/>
		);
	}
	return (
		<SettingsPage
			title={name.trim() || "New automation"}
			description={
				botFixed && bot
					? `Something ${bot.bot.name} does without being asked. Set it up, then create it.`
					: "Set it up, then create it."
			}
		>
			<SettingsGroup>
				<NameInputRow value={name} onChange={setName} />
				{botFixed && bot ? (
					// Begun from this bot's automations, so it is this bot's.
					<SettingsRow label="Bot" trailing={<SettingsValue>{bot.bot.name}</SettingsValue>} />
				) : (
					<BotRow
						chosen={bot}
						choices={choices}
						onChoose={(chosen) => {
							setBotId(chosen);
							// Another bot may not have the repositories its triggers watch.
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
			{actions.create.error && <Alert>{failureMessage(actions.create.error)}</Alert>}
			{/* At the foot, once it has been set up, where a form ends. */}
			<div className="flex justify-end gap-2">
				<Button variant="secondary" onClick={onCancel} disabled={actions.create.isPending}>
					Cancel
				</Button>
				<Button onClick={() => void create()} disabled={!ready || actions.create.isPending}>
					Create automation
				</Button>
			</div>
			<Dialog open={open !== undefined} onOpenChange={(opened) => !opened && setOpen(undefined)}>
				{open !== undefined && (
					<TriggerDialog
						bot={bot}
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

/** A trigger of an automation not made yet, by a key it keeps while it is changed. */
interface DraftedTrigger {
	key: string;
	draft: TriggerDraft;
}

/**

 * A copy of the automation on the same bot, paused so the two don't both run.
 * A webhook copy keeps its filter but has its own address and a new secret, so a
 * secret its sender made has to be pasted into it again. A repository copy runs on the
 * same repository and events.
 */
export function copyOf(automation: Automation, siblingNames: readonly string[]): NewAutomation {
	const fields = {
		name: copyName(automation.name, siblingNames),
		instructions: automation.instructions,
		state: "paused" as const,
	};
	return { ...fields, triggers: automation.triggers.map(copiedTrigger) };
}

/** A trigger as a copy of its automation has it: a webhook gets its own address and secret. */
function copiedTrigger(trigger: AutomationTrigger): AutomationTriggerInput {
	switch (trigger.kind) {
		case "schedule":
			return { kind: "schedule", schedule: trigger.schedule, timezone: trigger.timezone };
		case "webhook":
			return {
				kind: "webhook",
				auth: trigger.auth,
				deliveryIdHeader: trigger.deliveryIdHeader,
				filter: trigger.filter,
			};
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
 * fit an automation's name.
 */
function copyName(name: string, taken: readonly string[]): string {
	for (let number = 1; ; number++) {
		const suffix = number === 1 ? " copy" : ` copy ${number}`;
		const candidate = `${name.slice(0, MAX_AUTOMATION_NAME_CHARACTERS - suffix.length)}${suffix}`;
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
				maxLength={MAX_AUTOMATION_NAME_CHARACTERS}
				placeholder="e.g. Friday pipeline review"
				className="min-w-0 flex-1 rounded-md bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:shadow-(--ring-shadow)"
			/>
		</SettingsControlRow>
	);
}

/**
 * The automation's bot. Given `choices`, it opens in place to the bots it may
 * be made for; without them it only shows the bot.
 */
function BotRow({
	chosen,
	choices,
	onChoose,
}: {
	chosen: BotChoice | undefined;
	choices?: readonly BotChoice[];
	onChoose?: (botId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const choosable = choices && onChoose && choices.length > 1;
	const summary = chosen ? (
		<span className="flex min-w-0 flex-1 items-center gap-2.5">
			<BotAvatar
				color={chosen.bot.color}
				face={chosen.bot.face}
				shape={chosen.bot.shape}
				size={24}
			/>
			<span className="truncate text-xs text-foreground">{chosen.bot.name}</span>
		</span>
	) : (
		<span className="flex-1 text-xs text-muted-foreground">Choose a bot</span>
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
			{open && (
				<ul className="m-0 flex list-none flex-col p-0 pr-2 pb-1.5 pl-29">
					{choices.map(({ bot }) => (
						<li key={bot.id}>
							<button
								type="button"
								aria-pressed={bot.id === chosen?.bot.id}
								onClick={() => {
									onChoose(bot.id);
									setOpen(false);
								}}
								className="focus-ring flex w-full items-center gap-2.5 rounded-xl px-1 py-1.5 text-left transition-colors hover:bg-row-hover"
							>
								<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={24} />
								<span className="min-w-0 flex-1 truncate text-xs text-foreground">{bot.name}</span>
								{bot.id === chosen?.bot.id && (
									<Check aria-hidden size={16} strokeWidth={2.4} className="text-link" />
								)}
							</button>
						</li>
					))}
				</ul>
			)}
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

/** The note under an automation's instructions while they are written: what to say, and how much room is left. */
export function instructionsNote(instructions: string): string {
	return `Say what to look at, what to do, and what a good result looks like. ${countFormat.format(instructions.length)} of ${countFormat.format(MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS)} characters.`;
}

/** What an automation tells its bot each time it runs, on a page of its own with room to write. */
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
	/** What finishes the writing, under it: Save, or Done for an automation not made yet. */
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
					maxLength={MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS}
					placeholder="e.g. Summarise this week's replies and flag anything that has stalled."
					className="block min-h-95 w-full resize-y rounded-xl bg-transparent p-3.5 text-xs text-foreground leading-relaxed outline-none placeholder:text-subtle-foreground focus-visible:shadow-(--ring-shadow)"
				/>
			</SettingsGroup>
			{editable && <div className="flex justify-end">{action}</div>}
		</SettingsPage>
	);
}

export function DeleteAutomation({
	placed,
	open,
	onOpenChange,
	onDeleted,
}: {
	placed: PlacedAutomation;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onDeleted: () => void;
}) {
	const actions = useAutomationActions();
	return (
		<DeleteDialog
			open={open}
			onOpenChange={onOpenChange}
			title={`Delete ${placed.automation.name}?`}
			description="It stops running. Runs already in its bot's chat stay there."
			pending={actions.remove.isPending}
			error={actions.remove.error ? failureMessage(actions.remove.error) : undefined}
			onDelete={async () => {
				try {
					await actions.remove.mutateAsync({
						botId: placed.bot.id,
						automationId: placed.automation.id,
					});
				} catch {
					return;
				}
				onDeleted();
			}}
		/>
	);
}
