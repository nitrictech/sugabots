import {
	type Automation,
	type ConversationDetails,
	MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS,
	MAX_AUTOMATION_NAME_CHARACTERS,
} from "@sugabots/contracts";
import { cn } from "cn";
import { ChevronRight, Copy, Pencil, Play, Trash2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { useAutomationActions, useAutomations } from "@/lib/automations.ts";
import { useAutomationControls } from "@/lib/chats.ts";
import { failureMessage } from "@/lib/failure.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import {
	type ResourceOwner,
	resourcePermissions,
	resourceProjectId,
	useLeadBot,
	useNavigateToOwnerPage,
} from "@/lib/resource-owner.tsx";
import { useSaving } from "@/lib/saving.ts";
import { OwnerPageCrumb } from "@/shell/BotCrumb.tsx";
import { PageHeader } from "@/shell/Page.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { Dialog } from "@/ui/dialog.tsx";
import {
	DialogForm,
	DialogFormBody,
	DialogFormFooter,
	DialogFormHeader,
} from "@/ui/dialog-form.tsx";
import { DropdownMenuItem } from "@/ui/dropdown-menu.tsx";
import { InstructionsField } from "@/ui/instructions-field.tsx";
import { MoreMenu } from "@/ui/more-menu.tsx";
import { NameDialog } from "@/ui/name-dialog.tsx";
import { SETTINGS_CARD, SettingsGroup } from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { useCommittedDraft } from "@/ui/use-committed-draft.ts";
import {
	copyOf,
	DeleteAutomation,
	instructionsNote,
	type PlacedAutomation,
} from "./AutomationEditor.tsx";
import { RUN_OUTCOME_LABELS, type RunOutcome, RunStatus } from "./AutomationRun.tsx";
import {
	TriggerDialog,
	type TriggerSection,
	TriggersGroup,
	triggerDraftOf,
} from "./AutomationTriggers.tsx";
import { WebhookGroups } from "./AutomationWebhook.tsx";
import { ChatSidebar, ShowMore } from "./ChatSidebar.tsx";

/** What the panel reads of how the automation stands. */
type PanelStanding = Pick<
	NonNullable<ConversationDetails["automation"]>,
	"id" | "projectId" | "state" | "pausedAfterFailures"
>;

/** What the panel has open over the page, if anything. */
type PanelDialog =
	| { kind: "rename" }
	| { kind: "instructions" }
	| { kind: "delete" }
	/** A trigger, by its id. */
	| { kind: "trigger"; triggerId: string }
	/** A new routine, or another new trigger. */
	| { kind: "new_trigger"; section: TriggerSection };

/**
 * An automation beside its feed, set up in place: whether it is on, what it
 * is told, what starts it, and where its results go, then Run now. Its ⋯
 * renames, duplicates or deletes it. Somebody who may not manage its bot's or
 * project's automations sees it without being able to change it.
 *
 * Without `onClose` it is the automation's own page rather than beside its
 * feed: under its breadcrumb, with whether it runs, Run now and its ⋯ at the
 * top, and its instructions written straight into.
 */
export function AutomationPanel({
	owner,
	conversationId,
	standing,
	onClose,
}: {
	/** The bot or project whose automation it is. */
	owner: ResourceOwner;
	/** Its feed, refreshed when it changes; undefined where it is shown without one. */
	conversationId: string | undefined;
	/** How the automation stands, as its feed knows it. */
	standing: PanelStanding;
	/** Closes it beside the feed; undefined where it is the page. */
	onClose: (() => void) | undefined;
}) {
	const projectId = resourceProjectId(owner);
	const may = resourcePermissions(owner);
	// The bot that runs it, which its instructions are written to.
	const runner = useLeadBot(owner);
	const automations = useAutomations(projectId).data;
	const automation = automations?.find((one) => one.id === standing.id);
	const controls = useAutomationControls(conversationId, standing);
	const actions = useAutomationActions();
	const navigateToOwnerPage = useNavigateToOwnerPage();
	const [dialog, setDialog] = useState<PanelDialog>();
	// Pausing and Run now go through the feed's own controls, so why they failed is kept here.
	const [controlFailure, setControlFailure] = useState<unknown>();
	const mayManage = may.manageAutomations;
	const active = standing.state === "enabled";
	const close = () => setDialog(undefined);

	async function control(work: () => Promise<unknown>) {
		setControlFailure(undefined);
		try {
			await work();
		} catch (error) {
			setControlFailure(error);
		}
	}

	async function duplicate(original: Automation) {
		const siblingNames = (automations ?? []).map(({ name }) => name);
		try {
			const created = await actions.create.mutateAsync({
				projectId,
				json: copyOf(original, siblingNames),
			});
			await navigateToOwnerPage(owner, {
				page: "automation",
				automationId: created.automation.id,
			});
		} catch {
			// The panel shows the error.
		}
	}

	const more = mayManage && automation && (
		<MoreMenu label={`More for ${automation.name}`}>
			<DropdownMenuItem onClick={() => setDialog({ kind: "rename" })}>
				<Pencil aria-hidden size={16} />
				Rename
			</DropdownMenuItem>
			<DropdownMenuItem
				disabled={actions.create.isPending}
				onClick={() => void duplicate(automation)}
			>
				<Copy aria-hidden size={16} />
				Duplicate
			</DropdownMenuItem>
			<DropdownMenuItem variant="destructive" onClick={() => setDialog({ kind: "delete" })}>
				<Trash2 aria-hidden size={16} />
				Delete automation
			</DropdownMenuItem>
		</MoreMenu>
	);

	const stateSwitch = (
		<Toggle
			label="Automation on"
			tooltip={active ? "Pause automation" : "Resume automation"}
			checked={active}
			disabled={!mayManage || controls.pending}
			onChange={(on) => void control(() => controls.setPaused(!on))}
		/>
	);

	// On a phone, across from Back at the top, as a phone's page has its actions; else beside the name.
	const phone = !useMediaQuery(SIDE_BY_SIDE);

	const asPage = onClose === undefined;
	const moreInBar = phone && !asPage;
	const settings = (
		<>
			<div className="tab-bar-clearance flex min-h-0 flex-1 flex-col overflow-y-auto">
				{!asPage && (
					<div className="flex h-13 shrink-0 items-center gap-2 pr-3 pl-5 max-md:pl-4">
						<h3 className="m-0 min-w-0 flex-1 truncate font-semibold text-sm text-foreground">
							{automation?.name ?? "Automation"}
						</h3>
						{!moreInBar && more}
					</div>
				)}
				<div
					className={cn(
						"flex flex-col gap-3 px-4 pt-1 pb-6",
						asPage && "mx-auto w-full max-w-180 pt-6",
					)}
				>
					{actions.create.error && <Alert>{failureMessage(actions.create.error)}</Alert>}
					{actions.update.error && <Alert>{failureMessage(actions.update.error)}</Alert>}
					{controlFailure !== undefined && <Alert>{failureMessage(controlFailure)}</Alert>}
					{!asPage && (
						<div className={cn(SETTINGS_CARD, "flex h-12 items-center gap-2.5 px-3.5")}>
							<span className="flex-1">
								<RunStatus outcome={stateOutcome(standing)} />
							</span>
							{stateSwitch}
						</div>
					)}
					{automation && (
						<>
							{asPage ? (
								<InlineInstructions
									key={automation.instructions}
									instructions={automation.instructions}
									editable={mayManage}
									onSave={(instructions) =>
										actions.update.mutateAsync({
											projectId: projectId,
											automationId: automation.id,
											json: { instructions },
										})
									}
								/>
							) : (
								<Instructions
									instructions={automation.instructions}
									onEdit={mayManage ? () => setDialog({ kind: "instructions" }) : undefined}
								/>
							)}
							{(["routines", "triggers"] as const).map((section) => (
								<TriggersGroup
									key={section}
									section={section}
									triggers={automation.triggers.map((trigger) => ({ key: trigger.id, trigger }))}
									editable={mayManage}
									onOpen={(triggerId) => setDialog({ kind: "trigger", triggerId })}
									onAdd={() => setDialog({ kind: "new_trigger", section })}
									headingLevel={asPage ? 2 : 3}
								/>
							))}
						</>
					)}
					{!asPage && may.runAutomations && (
						<Button
							variant="secondary"
							disabled={controls.pending}
							onClick={() => void control(() => controls.runAgain())}
						>
							<Play aria-hidden size={12} strokeWidth={2} fill="currentColor" />
							Run now
						</Button>
					)}
				</div>
			</div>
			{automation && (
				<>
					<Dialog open={dialog?.kind === "rename"} onOpenChange={(opened) => !opened && close()}>
						{dialog?.kind === "rename" && (
							<NameDialog
								title="Rename automation"
								name={automation.name}
								maxLength={MAX_AUTOMATION_NAME_CHARACTERS}
								placeholder="e.g. Friday pipeline review"
								onSave={async (name) => {
									await controls.rename(name);
									close();
								}}
							/>
						)}
					</Dialog>
					<Dialog
						open={dialog?.kind === "instructions"}
						onOpenChange={(opened) => !opened && close()}
					>
						{dialog?.kind === "instructions" && (
							<InstructionsDialog
								botName={runner?.name ?? "the bot"}
								instructions={automation.instructions}
								onSave={async (instructions) => {
									await actions.update.mutateAsync({
										projectId: projectId,
										automationId: automation.id,
										json: { instructions },
									});
									close();
								}}
							/>
						)}
					</Dialog>
					<Dialog
						open={dialog?.kind === "trigger" || dialog?.kind === "new_trigger"}
						onOpenChange={(opened) => !opened && close()}
					>
						{(dialog?.kind === "trigger" || dialog?.kind === "new_trigger") && (
							<AutomationTriggerDialog
								placed={{ automation, owner }}
								opened={dialog}
								done={close}
							/>
						)}
					</Dialog>
					<DeleteAutomation
						placed={{ automation, owner }}
						open={dialog?.kind === "delete"}
						onOpenChange={(opened) => setDialog(opened ? { kind: "delete" } : undefined)}
						onDeleted={() =>
							void navigateToOwnerPage(owner, { page: "automations" }, { replace: true })
						}
					/>
				</>
			)}
		</>
	);
	if (asPage) {
		return (
			<section aria-label="Automation" className="flex min-h-0 min-w-0 flex-1 flex-col">
				<PageHeader
					title={automation?.name ?? "Automation"}
					parent={<OwnerPageCrumb owner={owner} page="automations" />}
					place={{ kind: "owner", owner }}
					actions={
						<span className="flex shrink-0 items-center gap-2">
							{/* Whether it runs, and running it now, at the top as a page's own actions. */}
							<span className="flex items-center gap-2 text-muted-foreground text-xs">
								<span className="max-md:sr-only">{RUN_OUTCOME_LABELS[stateOutcome(standing)]}</span>
								{stateSwitch}
							</span>
							{may.runAutomations && (
								<Button
									variant="secondary"
									size="sm"
									disabled={controls.pending}
									onClick={() => void control(() => controls.runAgain())}
								>
									<Play aria-hidden size={12} strokeWidth={2} fill="currentColor" />
									Run now
								</Button>
							)}
							{more}
						</span>
					}
				/>
				{settings}
			</section>
		);
	}
	return (
		<ChatSidebar
			label="Automation"
			onClose={onClose}
			headerless
			className="xl:w-85"
			actions={moreInBar && more}
		>
			{settings}
		</ChatSidebar>
	);
}

/** Whether the automation runs, as the status beside its switch says it. */
function stateOutcome(standing: PanelStanding): RunOutcome {
	if (standing.state === "enabled") return "on";
	return standing.pausedAfterFailures ? "pausedAfterFailures" : "paused";
}

/** Instructions longer than this are folded to four lines until asked for the rest. */
const INSTRUCTIONS_FOLDED_OVER = 200;

/** What the automation tells its bot, with Edit for somebody who may change it. */
function Instructions({
	instructions,
	onEdit,
}: {
	instructions: string;
	onEdit: (() => void) | undefined;
}) {
	const [open, setOpen] = useState(false);
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	const folds = instructions.length > INSTRUCTIONS_FOLDED_OVER;
	// On a phone, a row as settings' are, its first line cut short, which opens them all to change.
	if (phone && onEdit) {
		return (
			<button
				type="button"
				aria-label="Edit instructions"
				onClick={onEdit}
				className="focus-ring flex w-full items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-3 text-left active:bg-row-selected"
			>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="text-xs text-muted-foreground">Instructions</span>
					<span className="truncate text-sm text-soft-foreground">{instructions}</span>
				</span>
				<ChevronRight
					aria-hidden
					size={16}
					strokeWidth={2}
					className="shrink-0 text-subtle-foreground"
				/>
			</button>
		);
	}
	return (
		<div className={cn(SETTINGS_CARD, "flex flex-col gap-1.5 px-3.5 pt-3 pb-3.5")}>
			<div className="flex items-center gap-2">
				<h4 className="m-0 flex-1 font-normal text-xs text-muted-foreground">Instructions</h4>
				{onEdit && (
					<Button
						variant="quiet"
						size="text"
						aria-label="Edit instructions"
						onClick={onEdit}
						className="gap-0.5 text-muted-foreground"
					>
						Edit
						<ChevronRight aria-hidden size={13} strokeWidth={2.2} />
					</Button>
				)}
			</div>
			<p
				className={cn(
					"m-0 whitespace-pre-wrap text-xs text-soft-foreground leading-normal",
					folds && !open && "line-clamp-4",
				)}
			>
				{instructions}
			</p>
			{folds && <ShowMore open={open} onToggle={() => setOpen(!open)} />}
		</div>
	);
}

/**
 * The automation's instructions, written straight into on its own page and
 * saved when you leave the box. A save that fails puts them back. Somebody who
 * may not change them reads them.
 */
function InlineInstructions({
	instructions,
	editable,
	onSave,
}: {
	instructions: string;
	editable: boolean;
	onSave: (instructions: string) => Promise<unknown>;
}) {
	const { fieldProps } = useCommittedDraft(instructions, onSave);
	const id = useId();
	return (
		<div className={cn(SETTINGS_CARD, "flex flex-col gap-1 p-1")}>
			<label htmlFor={id} className="px-2.5 pt-2 text-muted-foreground text-xs">
				Instructions
			</label>
			<InstructionsField
				id={id}
				{...fieldProps}
				readOnly={!editable}
				maxLength={MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS}
				placeholder="What it should do each time it runs."
				className="min-h-48 rounded-lg px-2.5 pt-0 pb-2.5 text-sm text-soft-foreground"
			/>
		</div>
	);
}

/**
 * One of the automation's triggers, or a new one, saved as the dialog closes. A
 * webhook's address and secret save as they change, so its dialog is Done.
 */
function AutomationTriggerDialog({
	placed,
	opened,
	done,
}: {
	placed: PlacedAutomation;
	opened: Extract<PanelDialog, { kind: "trigger" | "new_trigger" }>;
	done: () => void;
}) {
	const { automation, owner } = placed;
	const actions = useAutomationActions();
	const addressed = { projectId: automation.projectId, automationId: automation.id };
	const editing =
		opened.kind === "trigger"
			? automation.triggers.find((trigger) => trigger.id === opened.triggerId)
			: undefined;
	return (
		<TriggerDialog
			owner={owner}
			editing={editing && triggerDraftOf(editing)}
			adding={opened.kind === "new_trigger" ? opened.section : undefined}
			settings={
				editing?.kind === "webhook" ? (
					<>
						{actions.updateTrigger.error && (
							<Alert>{failureMessage(actions.updateTrigger.error)}</Alert>
						)}
						<WebhookGroups
							placed={placed}
							triggerId={editing.id}
							auth={editing.auth}
							filter={editing.filter ?? []}
							onChangeFilter={(filter) =>
								actions.updateTrigger.mutateAsync({
									...addressed,
									triggerId: editing.id,
									json: { kind: "webhook", filter },
								})
							}
							deliveryIdHeader={editing.deliveryIdHeader}
							onChangeDeliveryIdHeader={(deliveryIdHeader) =>
								actions.updateTrigger.mutate({
									...addressed,
									triggerId: editing.id,
									json: { kind: "webhook", deliveryIdHeader },
								})
							}
							onChangeAuth={(auth) =>
								actions.updateTrigger.mutate({
									...addressed,
									triggerId: editing.id,
									json: { kind: "webhook", auth },
								})
							}
						/>
					</>
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
			done={done}
		/>
	);
}

/**
 * A form's submit that waits on `onSave`, keeping the dialog open with why
 * when it fails.
 */
function useSubmit(onSave: () => Promise<unknown>) {
	const { pending, failure, save } = useSaving();
	function submit(event: FormEvent) {
		event.preventDefault();
		void save(onSave);
	}
	return { saving: pending, failure, submit };
}

/** What the automation tells its bot each time it runs, with room to write. */
function InstructionsDialog({
	botName,
	instructions,
	onSave,
}: {
	botName: string;
	instructions: string;
	onSave: (instructions: string) => Promise<unknown>;
}) {
	const [draft, setDraft] = useState(instructions);
	const next = draft.trim();
	const { saving, failure, submit } = useSubmit(() => onSave(next));
	return (
		<DialogForm width="wide" onSubmit={submit}>
			<DialogFormHeader title="Instructions" />
			<DialogFormBody gap="compact">
				<p className="m-0 text-center text-xs text-muted-foreground">
					What {botName} does each time this runs.
				</p>
				<SettingsGroup className="p-1" note={instructionsNote(draft)}>
					<InstructionsField
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						maxLength={MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS}
						placeholder="e.g. Summarise this week's replies and flag anything that has stalled."
						className="p-3 text-sm"
					/>
				</SettingsGroup>
				{failure !== undefined && <Alert>{failureMessage(failure)}</Alert>}
			</DialogFormBody>
			<DialogFormFooter
				action={saving ? "Saving…" : "Save"}
				actionDisabled={saving || next === "" || next === instructions}
			/>
		</DialogForm>
	);
}
