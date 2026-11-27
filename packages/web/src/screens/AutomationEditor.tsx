import {
	type Automation,
	type AutomationTrigger,
	type AutomationTriggerInput,
	MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS,
	MAX_AUTOMATION_NAME_CHARACTERS,
	type NewAutomation,
} from "@sugabots/contracts";
import { type ReactNode, useState } from "react";
import { useAutomationActions } from "@/lib/automations.ts";
import { failureMessage } from "@/lib/failure.ts";
import {
	ownerName,
	type ResourceOwner,
	resourceProjectId,
	useLeadBot,
} from "@/lib/resource-owner.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import { InstructionsField } from "@/ui/instructions-field.tsx";
import {
	PageBackLink,
	SettingsFieldRow,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import {
	buildTriggerDraft,
	TriggerDialog,
	type TriggerDraft,
	type TriggerSection,
	TriggersGroup,
	triggerInputOf,
} from "./AutomationTriggers.tsx";

/** An automation with the bot or project it belongs to. */
export interface PlacedAutomation {
	automation: Automation;
	owner: ResourceOwner;
}

/** The page an automation shows: its own, or one of the parts that open from it. */
type AutomationSubpage = "automation" | "instructions";

/**
 * An automation being made for `owner`. Nothing is saved until Create, which
 * opens the new automation's own page; a webhook's secret is made then, and
 * shown there.
 */
export function NewAutomationPage({
	owner,
	onCancel,
	onCreated,
}: {
	/** The bot or project it is made for, whose automations it was begun from. */
	owner: ResourceOwner;
	onCancel: () => void;
	onCreated: (automation: Automation) => void;
}) {
	const [name, setName] = useState("");
	const [instructions, setInstructions] = useState("");
	const [triggers, setTriggers] = useState<readonly DraftedTrigger[]>([]);
	// The dialog open on a trigger, by its key, or on adding one to a section.
	const [open, setOpen] = useState<{ key: string } | { adding: TriggerSection }>();
	const [page, setPage] = useState<AutomationSubpage>("automation");
	const actions = useAutomationActions();
	const runner = useLeadBot(owner);
	const listed = triggers.flatMap(({ key, draft }) => {
		const written = triggerInputOf(draft);
		return "input" in written ? [{ key, trigger: written.input }] : [];
	});
	const ready = name.trim() !== "" && instructions.trim() !== "";
	const editing = open && "key" in open ? triggers.find((one) => one.key === open.key) : undefined;

	async function create() {
		if (!ready) return;
		try {
			const created = await actions.create.mutateAsync({
				projectId: resourceProjectId(owner),
				json: {
					name,
					instructions,
					triggers: listed.map(({ trigger }) => trigger),
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
				botName={runner?.name}
				value={instructions}
				onChange={setInstructions}
				action={<Button onClick={back}>Done</Button>}
			/>
		);
	}
	return (
		<SettingsPage
			title={name.trim() || "New automation"}
			description={
				runner
					? `Something ${runner.name} does without being asked. Set it up, then create it.`
					: "Set it up, then create it."
			}
		>
			<SettingsGroup>
				<SettingsFieldRow
					label="Name"
					value={name}
					onChange={setName}
					maxLength={MAX_AUTOMATION_NAME_CHARACTERS}
					placeholder="e.g. Friday pipeline review"
				/>
				<SettingsRow
					label={"bot" in owner ? "Bot" : "Project"}
					trailing={<SettingsValue>{ownerName(owner)}</SettingsValue>}
				/>
				<OpensRow
					label="Instructions"
					value={instructions.trim() === "" ? "Add" : "Edit"}
					onOpen={() => setPage("instructions")}
				/>
			</SettingsGroup>
			{(["routines", "triggers"] as const).map((section) => (
				<TriggersGroup
					key={section}
					section={section}
					triggers={listed}
					editable
					onOpen={(key) => setOpen({ key })}
					onAdd={() => setOpen({ adding: section })}
				/>
			))}
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
						owner={owner}
						editing={editing?.draft}
						adding={"adding" in open ? open.adding : undefined}
						onSave={async (input) => {
							const draft = buildTriggerDraft(input);
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
 * A copy of the automation in the same project, paused so the two don't both run.
 * A webhook copy keeps its filter but has its own address and a new secret, so a
 * secret its webhook source made has to be pasted into it again. A repository copy runs on the
 * same repository and events.
 */
export function buildAutomationCopy(
	automation: Automation,
	siblingNames: readonly string[],
): NewAutomation {
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
		case "routine":
			return { kind: "routine", schedule: trigger.schedule, timezone: trigger.timezone };
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
				connectorId: trigger.connectorId,
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

const CHARACTER_COUNT = new Intl.NumberFormat("en");

/** The note under an automation's instructions while they are written: what to say, and how much room is left. */
export function instructionsNote(instructions: string): string {
	return `Say what to look at, what to do, and what a good result looks like. ${CHARACTER_COUNT.format(instructions.length)} of ${CHARACTER_COUNT.format(MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS)} characters.`;
}

/** What an automation tells its bot each time it runs, on a page of its own with room to write. */
function InstructionsPage({
	back,
	botName,
	value,
	onChange,
	action,
}: {
	back: ReactNode;
	botName: string | undefined;
	value: string;
	onChange: (value: string) => void;
	/** What finishes the writing, under it. */
	action: ReactNode;
}) {
	return (
		<SettingsPage
			back={back}
			backOnWide
			title="Instructions"
			description={`What ${botName ?? "the bot"} does each time this runs.`}
		>
			<SettingsGroup className="p-1" note={instructionsNote(value)}>
				<InstructionsField
					value={value}
					onChange={(event) => onChange(event.target.value)}
					maxLength={MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS}
					placeholder="e.g. Summarise this week's replies and flag anything that has stalled."
					className="min-h-96"
				/>
			</SettingsGroup>
			<div className="flex justify-end">{action}</div>
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
			description="It stops running. Runs already in its feed stay there."
			pending={actions.remove.isPending}
			error={actions.remove.error ? failureMessage(actions.remove.error) : undefined}
			onDelete={async () => {
				try {
					await actions.remove.mutateAsync({
						projectId: placed.automation.projectId,
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
