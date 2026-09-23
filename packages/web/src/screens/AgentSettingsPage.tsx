import {
	type Agent,
	type AgentUpdate,
	builtInToolCatalog,
	connectionPresetFor,
	type Pod,
	PROMPT_MAX_LENGTH,
} from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Ellipsis } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useDeleteAgent, useUpdateAgent } from "@/lib/agents.ts";
import { useConnections, useToolApprovalRules } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { Input } from "@/ui/input.tsx";
import { LabeledField } from "@/ui/labeled-field.tsx";
import { Tab, TabPanel, Tabs, TabsList } from "@/ui/tabs.tsx";
import { Textarea } from "@/ui/textarea.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { AgentModelPicker } from "./AgentModelPicker.tsx";
import { AgentToolsDialog, agentToolsOf } from "./AgentToolAccess.tsx";
import { RoutinesSettings } from "./RoutinesSettings.tsx";

/*
 * One crew agent's settings: who it is at the top, then four tabs. Details is
 * what it is and where it works, Prompt is what it is told, Tools is what it
 * may reach for, Routines is what it does unprompted. What can be changed here
 * comes from the pod's resolved permissions, and a control nobody may use is
 * not drawn at all.
 *
 * Crew only. A built-in agent belongs to the workspace rather than to a pod and
 * has none of these, so it has a page of its own in `BuiltInAgentsSettings`.
 *
 * Each field saves on its own. A description saves when you leave it, a
 * model when you pick one, a switch when you flip it. The prompt is the one
 * exception: it is prose somebody may be part-way through, so it waits for
 * Save and offers Revert.
 */
export function AgentSettingsPage({
	agent,
	pod,
	initialTab,
}: {
	agent: Agent;
	/** The pod this agent lives in, and what the caller may do in it. */
	pod: Pod;
	initialTab?: "routines";
}) {
	const may = pod.permissions;
	const mayEdit = may.updateAgents;
	const update = useUpdateAgent(agent.id);
	const failure = update.error ? failureMessage(update.error) : undefined;

	return (
		<div
			className="agent-tint w-full max-w-[1080px] px-5 py-6 sm:px-8 sm:py-7"
			style={{ ["--agent-hue" as string]: agent.hue }}
		>
			<AgentHeader
				agent={agent}
				pod={pod}
				canEdit={mayEdit}
				canDelete={may.deleteAgents}
				save={update.mutateAsync}
				savePending={update.isPending}
			/>
			{failure !== undefined && <Alert className="mt-4">{failure}</Alert>}

			<Tabs defaultValue={initialTab ?? "details"} className="mt-6">
				<TabsList>
					<Tab value="details">Details</Tab>
					<Tab value="prompt">Prompt</Tab>
					<Tab value="tools">Tools</Tab>
					<Tab value="routines">Routines</Tab>
				</TabsList>
				<TabPanel value="details" className="flex max-w-[720px] flex-col gap-6">
					<Description
						agent={agent}
						editable={mayEdit}
						save={update.mutateAsync}
						savePending={update.isPending}
					/>
					<AgentModelPicker
						model={agent.model}
						canChoose={mayEdit}
						onChoose={(model) => {
							void update.mutateAsync({ model }).catch(() => {});
						}}
					/>
				</TabPanel>
				<TabPanel value="prompt" className="max-w-[720px]">
					<Prompt
						agent={agent}
						editable={mayEdit}
						save={update.mutateAsync}
						savePending={update.isPending}
					/>
				</TabPanel>
				<TabPanel value="tools" className="flex max-w-[720px] flex-col gap-7">
					<BuiltInTools agent={agent} canChange={mayEdit} save={update.mutateAsync} />
					<InheritedConnections agent={agent} pod={pod} />
				</TabPanel>
				<TabPanel value="routines">
					<RoutinesSettings agent={agent} canManage={may.manageRoutines} canRun={may.runRoutines} />
				</TabPanel>
			</Tabs>
		</div>
	);
}

/*
 * The face, the name and the handle, with a menu for what happens to the
 * agent as a whole: renaming it, or deleting it. Deleting asks first, since a
 * menu item is one slip away.
 */
function AgentHeader({
	agent,
	pod,
	canEdit,
	canDelete,
	save,
	savePending,
}: {
	agent: Agent;
	pod: Pod;
	canEdit: boolean;
	canDelete: boolean;
	save: (change: AgentUpdate) => Promise<unknown>;
	savePending: boolean;
}) {
	const [renaming, setRenaming] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const remove = useDeleteAgent();
	const navigate = useNavigate();

	async function deleteAgent() {
		try {
			await remove.mutateAsync(agent.id);
		} catch {
			return;
		}
		await navigate({ to: "/settings/pods/$pod", params: { pod: pod.id } });
	}

	return (
		<header className="flex flex-col gap-4">
			<div className="flex items-start gap-4">
				<IconButton
					label="Back to pod"
					className="mt-2 lg:hidden"
					render={<Link to="/settings/pods/$pod" params={{ pod: pod.id }} />}
				>
					<ArrowLeft />
				</IconButton>
				<AgentAvatar hue={agent.hue} face={agent.face} size={44} />
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					{renaming ? (
						<RenameForm
							agent={agent}
							save={save}
							savePending={savePending}
							done={() => setRenaming(false)}
						/>
					) : (
						<h2 className="m-0 truncate font-display text-2xl font-semibold text-heading">
							{agent.name}
						</h2>
					)}
					<span className="w-fit rounded-md bg-primary-tint px-1.5 py-0.5 font-mono text-sm text-primary-tint-foreground">
						@{agent.handle}
					</span>
				</div>
				{(canEdit || canDelete) && (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<IconButton label={`${agent.name} options`} variant="outline" size="lg">
									<Ellipsis />
								</IconButton>
							}
						/>
						<DropdownMenuContent align="end" className="min-w-44">
							{canEdit && (
								<DropdownMenuItem onClick={() => setRenaming(true)}>Rename</DropdownMenuItem>
							)}
							{canDelete && (
								<>
									{canEdit && <DropdownMenuSeparator />}
									<DropdownMenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
										Delete agent
									</DropdownMenuItem>
								</>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
			<DeleteDialog
				open={confirmingDelete}
				onOpenChange={setConfirmingDelete}
				title={`Delete ${agent.name}?`}
				description="This can't be undone."
				pending={remove.isPending}
				error={remove.error ? failureMessage(remove.error) : undefined}
				onDelete={deleteAgent}
			/>
		</header>
	);
}

function RenameForm({
	agent,
	save,
	savePending,
	done,
}: {
	agent: Agent;
	save: (change: AgentUpdate) => Promise<unknown>;
	savePending: boolean;
	done: () => void;
}) {
	const [draft, setDraft] = useState(agent.name);
	const id = useId();
	const name = draft.trim();

	async function rename() {
		try {
			await save({ name });
		} catch {
			return;
		}
		done();
	}

	return (
		<form
			className="flex flex-wrap items-center gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				void rename();
			}}
		>
			<label htmlFor={id} className="sr-only">
				Name
			</label>
			<Input
				id={id}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				className="min-w-40 flex-1 font-display text-lg font-semibold"
				maxLength={64}
				required
				disabled={savePending}
			/>
			<Button type="submit" size="sm" disabled={savePending || name === "" || name === agent.name}>
				Save name
			</Button>
			<Button type="button" size="sm" variant="outline" onClick={done} disabled={savePending}>
				Cancel
			</Button>
		</form>
	);
}

/** A bordered list, one row per child. */
function Card({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-card">
			{children}
		</div>
	);
}

/*
 * One line on what the agent is for. Saves when you leave the field or press
 * Enter, and only if it changed; Escape puts back what was there.
 */
function Description({
	agent,
	editable,
	save,
	savePending,
}: {
	agent: Agent;
	editable: boolean;
	save: (change: AgentUpdate) => Promise<unknown>;
	savePending: boolean;
}) {
	const [draft, setDraft] = useState(agent.description ?? "");
	const id = useId();
	const current = agent.description ?? "";

	function commit() {
		const next = draft.trim();
		if (savePending || next === current) return;
		void save({ description: next }).catch(() => {});
	}

	if (!editable) {
		return (
			<LabeledField label="Description">
				<p className="m-0 text-base text-foreground">
					{agent.description ?? <span className="text-subtle-foreground">No description yet.</span>}
				</p>
			</LabeledField>
		);
	}
	return (
		<LabeledField label="Description" htmlFor={id}>
			<Input
				id={id}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						commit();
					}
					if (event.key === "Escape") setDraft(current);
				}}
				className="h-11 rounded-xl px-3.5"
				placeholder="One line on what this agent is for."
				maxLength={280}
			/>
		</LabeledField>
	);
}

const countFormat = new Intl.NumberFormat("en");

/* The system prompt is saved explicitly so Revert can restore the persisted text. */
function Prompt({
	agent,
	editable,
	save,
	savePending,
}: {
	agent: Agent;
	editable: boolean;
	save: (change: AgentUpdate) => Promise<unknown>;
	savePending: boolean;
}) {
	const [draft, setDraft] = useState(agent.prompt);
	const id = useId();
	const dirty = draft !== agent.prompt;

	async function savePrompt() {
		try {
			await save({ prompt: draft });
		} catch {
			return;
		}
	}

	if (!editable) {
		return (
			<LabeledField label="System prompt">
				{agent.prompt === "" ? (
					<p className="m-0 text-base text-subtle-foreground">No instructions yet.</p>
				) : (
					<p className="m-0 whitespace-pre-wrap text-base leading-relaxed text-foreground">
						{agent.prompt}
					</p>
				)}
			</LabeledField>
		);
	}
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-baseline justify-between gap-3">
				<label htmlFor={id} className="font-semibold text-md text-heading">
					System prompt
				</label>
				<span className="font-mono text-xs text-muted-foreground tabular-nums">
					{countFormat.format(draft.length)} / {countFormat.format(PROMPT_MAX_LENGTH)}
				</span>
			</div>
			<Textarea
				id={id}
				value={draft}
				rows={10}
				maxLength={PROMPT_MAX_LENGTH}
				onChange={(event) => setDraft(event.target.value)}
				placeholder="What this agent is for and how it should behave. Left empty, it knows who it is and how to address people, but nothing about specific about its job."
				className="min-h-56 rounded-xl bg-card px-4 py-3 text-base leading-relaxed md:text-base"
				disabled={savePending}
			/>
			<div className="flex items-center justify-end gap-3 pt-1">
				<div className="flex items-center gap-2">
					<Button
						size="sm"
						variant="ghost"
						disabled={!dirty || savePending}
						onClick={() => setDraft(agent.prompt)}
					>
						Revert
					</Button>
					<Button size="sm" disabled={!dirty || savePending} onClick={() => void savePrompt()}>
						Save
					</Button>
				</div>
			</div>
		</div>
	);
}

/*
 * The built-in tools, each with a switch. On unless somebody switched it off
 * for this agent, and each switch is its own write, so there is nothing to
 * save.
 */
function BuiltInTools({
	agent,
	canChange,
	save,
}: {
	agent: Agent;
	canChange: boolean;
	save: (change: AgentUpdate) => Promise<unknown>;
}) {
	const onCount = builtInToolCatalog.filter((entry) => !agent.disabledTools.includes(entry.key));
	return (
		<LabeledField
			label="Workspace tools"
			count={`${onCount.length} of ${builtInToolCatalog.length} on`}
		>
			<Card>
				{builtInToolCatalog.map((entry) => {
					const on = !agent.disabledTools.includes(entry.key);
					return (
						<div key={entry.key} className="flex min-h-11 items-center gap-3 px-4 py-2">
							<span
								className="min-w-0 flex-1 truncate font-medium text-base text-heading"
								title={entry.description}
							>
								{entry.name}
							</span>
							<code className="text-muted-foreground text-xs">{entry.key}</code>
							{canChange ? (
								<Toggle
									checked={on}
									label={`${on ? "Turn off" : "Turn on"} ${entry.name}`}
									onChange={(next) =>
										save({
											disabledTools: next
												? agent.disabledTools.filter((key) => key !== entry.key)
												: [...agent.disabledTools, entry.key],
										}).catch(() => {})
									}
								/>
							) : (
								<span className="w-11 text-right text-md text-muted-foreground">
									{on ? "On" : "Off"}
								</span>
							)}
						</div>
					);
				})}
			</Card>
		</LabeledField>
	);
}

function InheritedConnections({ agent, pod }: { agent: Agent; pod: Pod }) {
	const connections = useConnections(pod.id);
	const rules = useToolApprovalRules(pod.id);
	const [openConnectionId, setOpenConnectionId] = useState<string>();
	if (connections.isPending) {
		return <LabeledField label="Pod connections">Loading connections...</LabeledField>;
	}
	if (connections.isError) {
		return (
			<LabeledField label="Pod connections">
				<Alert>{failureMessage(connections.error)}</Alert>
			</LabeledField>
		);
	}
	const enabled = connections.data.filter((connection) => connection.enabled);
	return (
		<LabeledField label="Pod connections" count={`${enabled.length} enabled`}>
			{enabled.length > 0 ? (
				<Card>
					{enabled.map((connection) => {
						const tools = agentToolsOf(connection, rules.data ?? [], agent.id);
						const unavailable = tools.filter((entry) => entry.access === "unavailable").length;
						const available = tools.length - unavailable;
						const presetId = connectionPresetFor(connection.url)?.id;
						return (
							<div key={connection.id}>
								<button
									type="button"
									onClick={() => setOpenConnectionId(connection.id)}
									className="focus-ring flex min-h-12 w-full cursor-pointer items-center gap-3 px-4 py-2 text-left hover:bg-sunken"
								>
									<ConnectionMark presetId={presetId} name={connection.name} hue={agent.hue} />
									<span className="min-w-0 flex-1 truncate font-medium text-base text-heading">
										{connection.name}
									</span>
									<span className="text-muted-foreground text-sm">
										{available} {available === 1 ? "tool" : "tools"}
										{unavailable > 0 && ` · ${unavailable} not available`}
									</span>
								</button>
								<AgentToolsDialog
									agentName={agent.name}
									connection={connection}
									tools={tools}
									presetId={presetId}
									markHue={agent.hue}
									open={openConnectionId === connection.id}
									onOpenChange={(open) => setOpenConnectionId(open ? connection.id : undefined)}
								/>
							</div>
						);
					})}
				</Card>
			) : (
				<p className="m-0 text-base text-subtle-foreground">
					No pod connections are enabled for this agent.
				</p>
			)}
			<Button
				size="bare"
				variant="link"
				className="mt-2"
				render={<Link to="/settings/pods/$pod" params={{ pod: pod.id }} />}
			>
				View pod connections
			</Button>
		</LabeledField>
	);
}
