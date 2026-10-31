import {
	type Agent,
	MAX_ROUTINE_INSTRUCTIONS_CHARACTERS,
	MAX_ROUTINE_NAME_CHARACTERS,
	type Pod,
	type Routine,
	type ThreadDetails,
} from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRight, Copy, Pencil, Play, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { useRoutineControls } from "@/lib/chats.ts";
import { failureMessage } from "@/lib/failure.ts";
import { routinesLink, routineThreadLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { triggerLabel } from "@/lib/routine-schedule.ts";
import { useRoutineActions, useRoutines } from "@/lib/routines.ts";
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
import { ChatSidebar } from "./ChatSidebar.tsx";
import { ChatRow, copyOf, DeleteRoutine, instructionsNote } from "./RoutineEditor.tsx";
import { TriggerKindMark, triggerKindChoice } from "./RoutineTriggerKinds.tsx";
import { TriggerDialog, triggerDraftOf } from "./RoutineTriggers.tsx";
import { WebhookGroups } from "./RoutineWebhook.tsx";

/** What the panel has open over the page, if anything. */
type PanelDialog =
	| { kind: "rename" }
	| { kind: "instructions" }
	| { kind: "delete" }
	/** A trigger, by its id, or a new one while it has none. */
	| { kind: "trigger"; triggerId: string | undefined };

/**
 * A routine beside its own thread, set up in place: whether it is on, what it
 * is told, what starts it, and where its results go, then Run now. Its ⋯
 * renames, duplicates or deletes it. Somebody who may not manage its bot's
 * routines sees it without being able to change it.
 */
export function RoutinePanel({
	agent,
	pod,
	conversationId,
	standing,
	onClose,
}: {
	agent: Agent;
	pod: Pod;
	conversationId: string;
	/** How the routine stands, as its thread knows it. */
	standing: NonNullable<ThreadDetails["routine"]>;
	onClose: () => void;
}) {
	const routines = useRoutines(agent.id).data;
	const routine = routines?.find((one) => one.id === standing.id);
	const controls = useRoutineControls(conversationId, standing);
	const actions = useRoutineActions();
	const navigate = useNavigate();
	const [dialog, setDialog] = useState<PanelDialog>();
	// Pausing and Run now go through the thread's own controls, so why they failed is kept here.
	const [controlFailure, setControlFailure] = useState<unknown>();
	const mayManage = pod.permissions.manageRoutines;
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

	async function duplicate(original: Routine) {
		const siblingNames = (routines ?? []).map(({ name }) => name);
		try {
			const created = await actions.create.mutateAsync({
				agentId: agent.id,
				json: copyOf(original, siblingNames),
			});
			await navigate(routineThreadLink(pod, created.routine.id));
		} catch {
			// The panel shows the error.
		}
	}

	const more = mayManage && routine && (
		<MoreMenu label={`More for ${routine.name}`}>
			<DropdownMenuItem onClick={() => setDialog({ kind: "rename" })}>
				<Pencil aria-hidden size={16} />
				Rename
			</DropdownMenuItem>
			<DropdownMenuItem disabled={actions.create.isPending} onClick={() => void duplicate(routine)}>
				<Copy aria-hidden size={16} />
				Duplicate
			</DropdownMenuItem>
			<DropdownMenuItem variant="destructive" onClick={() => setDialog({ kind: "delete" })}>
				<Trash2 aria-hidden size={16} />
				Delete routine
			</DropdownMenuItem>
		</MoreMenu>
	);

	// On a phone, across from Back at the top, as a phone's page has its actions; else beside the name.
	const phone = !useMediaQuery(SIDE_BY_SIDE);

	return (
		<ChatSidebar
			label="Routine"
			onClose={onClose}
			headerless
			className="xl:w-[340px]"
			actions={phone && more}
		>
			<div className="tab-bar-clearance flex min-h-0 flex-1 flex-col overflow-y-auto">
				<div className="flex h-[52px] shrink-0 items-center gap-2 pr-3 pl-5 max-md:pl-4">
					<h3 className="m-0 min-w-0 flex-1 truncate font-semibold text-[14px] text-foreground">
						{routine?.name ?? "Routine"}
					</h3>
					{!phone && more}
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
								active ? "bg-success" : "bg-disabled-foreground",
							)}
						/>
						<span className="flex-1 text-[13px] text-foreground">
							{active
								? "Active"
								: standing.pausedAfterFailures
									? "Paused after two failures"
									: "Paused"}
						</span>
						<Toggle
							label="Routine on"
							tooltip={active ? "Pause routine" : "Resume routine"}
							checked={active}
							disabled={!mayManage || controls.pending}
							onChange={(on) => void control(() => controls.setPaused(!on))}
						/>
					</PanelCard>
					{routine && (
						<>
							<Instructions
								instructions={routine.instructions}
								onEdit={mayManage ? () => setDialog({ kind: "instructions" }) : undefined}
							/>
							<Triggers
								routine={routine}
								editable={mayManage}
								onOpen={(triggerId) => setDialog({ kind: "trigger", triggerId })}
							/>
							<PanelCard>
								<fieldset disabled={!mayManage} className="contents">
									{/* Ruled off from the chat picker under it, which a pod with one chat doesn't show. */}
									<div className="flex min-h-12 items-center gap-3 border-border border-b px-3.5 py-2.5 last:border-b-0">
										<span className="flex-1 text-[13px] text-foreground">
											Also post result in the pod's channel
										</span>
										<Toggle
											label="Also post result in the pod's channel"
											checked={routine.results === "post_to_chat"}
											onChange={(posted) =>
												actions.update.mutate({
													agentId: agent.id,
													routineId: routine.id,
													json: { results: posted ? "post_to_chat" : "keep_in_run" },
												})
											}
										/>
									</div>
									{routine.results === "post_to_chat" && (
										<ChatRow
											pod={pod}
											chatId={routine.chatId}
											onChange={(chatId) =>
												actions.update.mutate({
													agentId: agent.id,
													routineId: routine.id,
													json: { chatId },
												})
											}
										/>
									)}
								</fieldset>
							</PanelCard>
						</>
					)}
					{pod.permissions.runRoutines && (
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
			{routine && (
				<>
					<Dialog open={dialog?.kind === "rename"} onOpenChange={(opened) => !opened && close()}>
						{dialog?.kind === "rename" && (
							<RenameDialog
								name={routine.name}
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
								botName={agent.name}
								instructions={routine.instructions}
								onSave={async (instructions) => {
									await actions.update.mutateAsync({
										agentId: agent.id,
										routineId: routine.id,
										json: { instructions },
									});
									close();
								}}
							/>
						)}
					</Dialog>
					<Dialog open={dialog?.kind === "trigger"} onOpenChange={(opened) => !opened && close()}>
						{dialog?.kind === "trigger" && (
							<RoutineTriggerDialog
								placed={{ routine, agent, pod }}
								triggerId={dialog.triggerId}
								done={close}
							/>
						)}
					</Dialog>
					<DeleteRoutine
						placed={{ routine, agent, pod }}
						open={dialog?.kind === "delete"}
						onOpenChange={(opened) => setDialog(opened ? { kind: "delete" } : undefined)}
						onDeleted={() => void navigate({ ...routinesLink(pod, agent), replace: true })}
					/>
				</>
			)}
		</ChatSidebar>
	);
}

/** A card in the panel, one of the routine's settings or a group of them. */
function PanelCard({ className, children }: { className?: string; children: ReactNode }) {
	return (
		<div className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}>
			{children}
		</div>
	);
}

/** Instructions longer than this are folded to four lines until asked for the rest. */
const INSTRUCTIONS_FOLDED_OVER = 200;

/** What the routine tells its bot, with Edit for somebody who may change it. */
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
					<span className="text-[13px] text-muted-foreground">Instructions</span>
					<span className="truncate text-[14px] text-soft-foreground">{instructions}</span>
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
				<h4 className="m-0 flex-1 font-normal text-[13px] text-muted-foreground">Instructions</h4>
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
					"m-0 whitespace-pre-wrap text-[13px] text-soft-foreground leading-[1.55]",
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

/** What starts the routine, each opening to change it, then Add trigger, for somebody who may. */
function Triggers({
	routine,
	editable,
	onOpen,
}: {
	routine: Routine;
	editable: boolean;
	/** Opens a trigger, by its id, or a new one. */
	onOpen: (triggerId: string | undefined) => void;
}) {
	return (
		<section aria-labelledby={`${routine.id}-triggers`} className="flex flex-col gap-2 pt-1">
			<h4
				id={`${routine.id}-triggers`}
				className="m-0 px-0.5 font-normal text-[13px] text-muted-foreground"
			>
				Triggers
			</h4>
			<PanelCard>
				<ul className="m-0 flex list-none flex-col p-0">
					{routine.triggers.length === 0 && (
						<li className="border-border border-b px-3.5 py-3 text-[13px] text-muted-foreground last:border-b-0">
							None. It runs only when someone runs it.
						</li>
					)}
					{routine.triggers.map((trigger) => {
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
				<span className="truncate text-[13px] text-foreground">{label}</span>
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
 * One of the routine's triggers, or a new one, saved as the dialog closes. A
 * webhook's address and secret save as they change, so its dialog is Done.
 */
function RoutineTriggerDialog({
	placed,
	triggerId,
	done,
}: {
	placed: { routine: Routine; agent: Agent; pod: Pod };
	triggerId: string | undefined;
	done: () => void;
}) {
	const { routine, agent, pod } = placed;
	const actions = useRoutineActions();
	const addressed = { agentId: agent.id, routineId: routine.id };
	const editing = routine.triggers.find((trigger) => trigger.id === triggerId);
	return (
		<TriggerDialog
			pod={pod}
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
			<DialogFormHeader title="Rename routine" />
			<DialogFormBody gap="compact">
				<SettingsGroup>
					<SettingsFieldRow
						label="Name"
						value={name}
						onChange={setName}
						placeholder="e.g. Friday pipeline review"
						maxLength={MAX_ROUTINE_NAME_CHARACTERS}
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

/** What the routine tells its bot each time it runs, with room to write. */
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
				<p className="m-0 text-center text-[13px] text-muted-foreground">
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
						maxLength={MAX_ROUTINE_INSTRUCTIONS_CHARACTERS}
						placeholder="e.g. Summarise this week's replies and flag anything that has stalled."
						className="block min-h-[240px] w-full resize-y rounded-[12px] bg-transparent p-3 text-[14px] text-foreground leading-[1.6] outline-none placeholder:text-subtle-foreground focus-visible:shadow-(--ring-shadow)"
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
