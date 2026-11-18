import {
	type Automation,
	type Bot,
	type ConversationDetails,
	MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS,
	MAX_AUTOMATION_NAME_CHARACTERS,
} from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRight, Copy, Pencil, Play, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { triggerLabel } from "@/lib/automation-schedule.ts";
import { useAutomationActions, useAutomations } from "@/lib/automations.ts";
import { useAutomationControls } from "@/lib/chats.ts";
import { failureMessage } from "@/lib/failure.ts";
import { automationFeedLink, automationsLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
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
import { MoreMenu } from "@/ui/more-menu.tsx";
import { SettingsAddMark, SettingsFieldRow, SettingsGroup } from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { copyOf, DeleteAutomation, instructionsNote } from "./AutomationEditor.tsx";
import { TriggerKindMark, triggerKindChoice } from "./AutomationTriggerKinds.tsx";
import { TriggerDialog, triggerDraftOf } from "./AutomationTriggers.tsx";
import { WebhookGroups } from "./AutomationWebhook.tsx";
import { ChatSidebar } from "./ChatSidebar.tsx";

/** What the panel has open over the page, if anything. */
type PanelDialog =
	| { kind: "rename" }
	| { kind: "instructions" }
	| { kind: "delete" }
	/** A trigger, by its id, or a new one while it has none. */
	| { kind: "trigger"; triggerId: string | undefined };

/**
 * An automation beside its feed, set up in place: whether it is on, what it
 * is told, what starts it, and where its results go, then Run now. Its ⋯
 * renames, duplicates or deletes it. Somebody who may not manage its bot's
 * automations sees it without being able to change it.
 *
 * Without `onClose` it is a page of its own rather than beside a feed, for
 * somebody who manages the automation without reaching its bot or its feed.
 */
export function AutomationPanel({
	bot,
	conversationId,
	standing,
	onClose,
}: {
	bot: Bot;
	/** Its feed, refreshed when it changes; undefined where it is shown without one. */
	conversationId: string | undefined;
	/** How the automation stands, as its feed knows it. */
	standing: NonNullable<ConversationDetails["automation"]>;
	/** Closes it beside the feed; undefined where it is the page. */
	onClose: (() => void) | undefined;
}) {
	const automations = useAutomations(bot.id).data;
	const automation = automations?.find((one) => one.id === standing.id);
	const controls = useAutomationControls(conversationId, standing);
	const actions = useAutomationActions();
	const navigate = useNavigate();
	const [dialog, setDialog] = useState<PanelDialog>();
	// Pausing and Run now go through the feed's own controls, so why they failed is kept here.
	const [controlFailure, setControlFailure] = useState<unknown>();
	const mayManage = bot.permissions.manageAutomations;
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
				botId: bot.id,
				json: copyOf(original, siblingNames),
			});
			await navigate(automationFeedLink(bot, created.automation.id));
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

	// On a phone, across from Back at the top, as a phone's page has its actions; else beside the name.
	const phone = !useMediaQuery(SIDE_BY_SIDE);

	// A page of its own keeps its ⋯ beside the name, as it has no sidebar's bar to put it in.
	const moreInBar = phone && onClose !== undefined;
	const settings = (
		<>
			<div className="tab-bar-clearance flex min-h-0 flex-1 flex-col overflow-y-auto">
				<div className="flex h-13 shrink-0 items-center gap-2 pr-3 pl-5 max-md:pl-4">
					<h3 className="m-0 min-w-0 flex-1 truncate font-semibold text-sm text-foreground">
						{automation?.name ?? "Automation"}
					</h3>
					{!moreInBar && more}
				</div>
				<div className="flex flex-col gap-3 px-4 pt-1 pb-6">
					{actions.create.error && <Alert>{failureMessage(actions.create.error)}</Alert>}
					{actions.update.error && <Alert>{failureMessage(actions.update.error)}</Alert>}
					{controlFailure !== undefined && <Alert>{failureMessage(controlFailure)}</Alert>}
					<PanelCard className="flex h-12 items-center gap-2.5 px-3.5">
						<span
							aria-hidden
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								active
									? "bg-success"
									: standing.pausedAfterFailures
										? "bg-destructive-text"
										: "bg-disabled-foreground",
							)}
						/>
						<span className="flex-1 text-xs text-foreground">
							{active
								? "Active"
								: standing.pausedAfterFailures
									? "Paused after two failures"
									: "Paused"}
						</span>
						<Toggle
							label="Automation on"
							tooltip={active ? "Pause automation" : "Resume automation"}
							checked={active}
							disabled={!mayManage || controls.pending}
							onChange={(on) => void control(() => controls.setPaused(!on))}
						/>
					</PanelCard>
					{automation && (
						<>
							<Instructions
								instructions={automation.instructions}
								onEdit={mayManage ? () => setDialog({ kind: "instructions" }) : undefined}
							/>
							<Triggers
								automation={automation}
								editable={mayManage}
								onOpen={(triggerId) => setDialog({ kind: "trigger", triggerId })}
							/>
						</>
					)}
					{bot.permissions.runAutomations && (
						<Button
							variant="outline"
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
							<RenameDialog
								name={automation.name}
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
								botName={bot.name}
								instructions={automation.instructions}
								onSave={async (instructions) => {
									await actions.update.mutateAsync({
										botId: bot.id,
										automationId: automation.id,
										json: { instructions },
									});
									close();
								}}
							/>
						)}
					</Dialog>
					<Dialog open={dialog?.kind === "trigger"} onOpenChange={(opened) => !opened && close()}>
						{dialog?.kind === "trigger" && (
							<AutomationTriggerDialog
								placed={{ automation, bot }}
								triggerId={dialog.triggerId}
								done={close}
							/>
						)}
					</Dialog>
					<DeleteAutomation
						placed={{ automation, bot }}
						open={dialog?.kind === "delete"}
						onOpenChange={(opened) => setDialog(opened ? { kind: "delete" } : undefined)}
						onDeleted={() => void navigate({ ...automationsLink(bot), replace: true })}
					/>
				</>
			)}
		</>
	);
	if (!onClose) return settings;
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

/** A card in the panel, one of the automation's settings or a group of them. */
function PanelCard({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<div className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>
			{children}
		</div>
	);
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
		<PanelCard className="flex flex-col gap-1.5 px-3.5 pt-3 pb-3.5">
			<div className="flex items-center gap-2">
				<h4 className="m-0 flex-1 font-normal text-xs text-muted-foreground">Instructions</h4>
				{onEdit && (
					<button
						type="button"
						aria-label="Edit instructions"
						onClick={onEdit}
						className="focus-ring inline-flex items-center gap-0.5 rounded-sm text-muted-foreground text-xs hover:text-foreground"
					>
						Edit
						<ChevronRight aria-hidden size={13} strokeWidth={2.2} />
					</button>
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
			{folds && (
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen(!open)}
					className="focus-ring self-start rounded-sm text-muted-foreground text-xs hover:text-foreground"
				>
					{open ? "Show less" : "Show more"}
				</button>
			)}
		</PanelCard>
	);
}

/** What starts the automation, each opening to change it, then Add trigger, for somebody who may. */
function Triggers({
	automation,
	editable,
	onOpen,
}: {
	automation: Automation;
	editable: boolean;
	/** Opens a trigger, by its id, or a new one. */
	onOpen: (triggerId: string | undefined) => void;
}) {
	return (
		<section aria-labelledby={`${automation.id}-triggers`} className="flex flex-col gap-2 pt-1">
			<h4
				id={`${automation.id}-triggers`}
				className="m-0 px-0.5 font-normal text-xs text-muted-foreground"
			>
				Triggers
			</h4>
			<PanelCard>
				<ul className="m-0 flex list-none flex-col p-0">
					{automation.triggers.length === 0 && (
						<li className="border-border border-b px-3.5 py-3 text-xs text-muted-foreground last:border-b-0">
							None. It runs only when someone runs it.
						</li>
					)}
					{automation.triggers.map((trigger) => {
						const choice = triggerKindChoice(trigger.kind);
						return (
							<li key={trigger.id} className="border-border border-b last:border-b-0">
								<TriggerRow
									icon={<TriggerKindMark choice={choice} />}
									label={choice.label}
									sub={triggerLabel(trigger)}
									onClick={editable ? () => onOpen(trigger.id) : undefined}
								/>
							</li>
						);
					})}
					{editable && (
						<li>
							<TriggerRow
								icon={<SettingsAddMark />}
								label="Add trigger"
								onClick={() => onOpen(undefined)}
							/>
						</li>
					)}
				</ul>
			</PanelCard>
		</section>
	);
}

function TriggerRow({
	icon,
	label,
	sub,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	sub?: string;
	onClick: (() => void) | undefined;
}) {
	const contents = (
		<>
			{icon}
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-xs text-foreground">{label}</span>
				{sub && <span className="truncate text-muted-foreground text-xs">{sub}</span>}
			</span>
			{onClick && sub && (
				<ChevronRight
					aria-hidden
					size={14}
					strokeWidth={2.2}
					className="shrink-0 text-subtle-foreground"
				/>
			)}
		</>
	);
	const className = "flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left";
	if (!onClick) return <div className={className}>{contents}</div>;
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(className, "focus-ring transition-colors hover:bg-row-hover")}
		>
			{contents}
		</button>
	);
}

/**
 * One of the automation's triggers, or a new one, saved as the dialog closes. A
 * webhook's address and secret save as they change, so its dialog is Done.
 */
function AutomationTriggerDialog({
	placed,
	triggerId,
	done,
}: {
	placed: { automation: Automation; bot: Bot };
	triggerId: string | undefined;
	done: () => void;
}) {
	const { automation, bot } = placed;
	const actions = useAutomationActions();
	const addressed = { botId: bot.id, automationId: automation.id };
	const editing = automation.triggers.find((trigger) => trigger.id === triggerId);
	return (
		<TriggerDialog
			bot={{ bot }}
			editing={editing && triggerDraftOf(editing)}
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
function useSaving(onSave: () => Promise<unknown>) {
	const [saving, setSaving] = useState(false);
	const [failure, setFailure] = useState<unknown>();
	async function submit(event: FormEvent) {
		event.preventDefault();
		if (saving) return;
		setSaving(true);
		setFailure(undefined);
		try {
			await onSave();
		} catch (error) {
			setFailure(error);
		} finally {
			setSaving(false);
		}
	}
	return { saving, failure, submit };
}

function RenameDialog({
	name: initialName,
	onSave,
}: {
	name: string;
	onSave: (name: string) => Promise<unknown>;
}) {
	const [name, setName] = useState(initialName);
	const next = name.trim();
	const { saving, failure, submit } = useSaving(() => onSave(next));
	return (
		<DialogForm onSubmit={submit}>
			<DialogFormHeader title="Rename automation" />
			<DialogFormBody gap="compact">
				<SettingsGroup>
					<SettingsFieldRow
						label="Name"
						value={name}
						onChange={setName}
						placeholder="e.g. Friday pipeline review"
						maxLength={MAX_AUTOMATION_NAME_CHARACTERS}
					/>
				</SettingsGroup>
				{failure !== undefined && <Alert>{failureMessage(failure)}</Alert>}
			</DialogFormBody>
			<DialogFormFooter
				action="Save"
				actionDisabled={saving || next === "" || next === initialName}
			/>
		</DialogForm>
	);
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
	const id = useId();
	const [draft, setDraft] = useState(instructions);
	const next = draft.trim();
	const { saving, failure, submit } = useSaving(() => onSave(next));
	return (
		<DialogForm width="wide" onSubmit={submit}>
			<DialogFormHeader title="Instructions" />
			<DialogFormBody gap="compact">
				<p className="m-0 text-center text-xs text-muted-foreground">
					What {botName} does each time this runs.
				</p>
				<SettingsGroup className="p-1" note={instructionsNote(draft)}>
					<label htmlFor={id} className="sr-only">
						Instructions
					</label>
					<textarea
						id={id}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						maxLength={MAX_AUTOMATION_INSTRUCTIONS_CHARACTERS}
						placeholder="e.g. Summarise this week's replies and flag anything that has stalled."
						className="block min-h-60 w-full resize-y rounded-xl bg-transparent p-3 text-sm text-foreground leading-relaxed outline-none placeholder:text-subtle-foreground focus-visible:shadow-(--ring-shadow)"
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
