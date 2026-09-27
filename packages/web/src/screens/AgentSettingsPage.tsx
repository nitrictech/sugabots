import {
	type Agent,
	type AgentUpdate,
	builtInToolCatalog,
	connectionPresetFor,
	type Pod,
	PROMPT_MAX_LENGTH,
} from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useAgents, useDeleteAgent, useModels, useUpdateAgent } from "@/lib/agents.ts";
import { useConnections } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { podSettingsLink } from "@/lib/links.ts";
import { useWebAccess } from "@/lib/search-provider.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { ColourPicker, EyesPicker } from "@/shell/LookPickers.tsx";
import { PodTile } from "@/shell/PodTile.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import {
	PageBackLink,
	SettingsDanger,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { AgentModelPicker } from "./AgentModelPicker.tsx";
import { AgentToolsDialog, agentToolsOf } from "./AgentToolAccess.tsx";
import { AgentRoutines } from "./RoutinesSettings.tsx";

/*
 * One bot, as its contact card: its face and colour first, then what it is,
 * what it thinks with and what it is told, what it can reach, and what it does
 * unprompted. Model and instructions each open on a page of their own in the
 * same place, so the card never rearranges under you.
 *
 * What can be changed comes from the pod's resolved permissions, and a control
 * nobody may use is not drawn. Each field saves on its own; instructions are
 * prose somebody may be part-way through, so they wait for Save.
 */
export function AgentSettingsPage({
	agent,
	pod,
	initialTab,
}: {
	agent: Agent;
	/** The pod this bot lives in, and what the viewer may do in it. */
	pod: Pod;
	/** Opens scrolled to its routines, for a link from a routine run. */
	initialTab?: "routines";
}) {
	const [page, setPage] = useState<"card" | "model" | "instructions">("card");
	const update = useUpdateAgent(agent.id);
	const failure = update.error ? failureMessage(update.error) : undefined;
	const back = (
		<PageBackLink
			label={agent.name}
			render={<button type="button" onClick={() => setPage("card")} />}
		/>
	);

	if (page === "model") {
		return (
			<SettingsPage back={back} title="Model" description={`What ${agent.name} thinks with.`}>
				{failure && <Alert>{failure}</Alert>}
				<AgentModelPicker
					model={agent.model}
					canChoose={pod.permissions.updateAgents}
					onChoose={(model) => {
						void update.mutateAsync({ model }).catch(() => {});
					}}
				/>
			</SettingsPage>
		);
	}
	if (page === "instructions") {
		return (
			<Instructions
				agent={agent}
				editable={pod.permissions.updateAgents}
				back={back}
				save={update.mutateAsync}
				savePending={update.isPending}
				failure={failure}
			/>
		);
	}
	return (
		<ContactCard
			agent={agent}
			pod={pod}
			initialTab={initialTab}
			save={update.mutateAsync}
			savePending={update.isPending}
			failure={failure}
			onOpenModel={() => setPage("model")}
			onOpenInstructions={() => setPage("instructions")}
		/>
	);
}

type Save = (change: AgentUpdate) => Promise<unknown>;

function ContactCard({
	agent,
	pod,
	initialTab,
	save,
	savePending,
	failure,
	onOpenModel,
	onOpenInstructions,
}: {
	agent: Agent;
	pod: Pod;
	initialTab?: "routines";
	save: Save;
	savePending: boolean;
	failure: string | undefined;
	onOpenModel: () => void;
	onOpenInstructions: () => void;
}) {
	const may = pod.permissions;
	const models = useModels();
	const inUse = models.data?.models.find((model) => model.modelId === agent.model);
	const modelName = inUse ? (inUse.displayName ?? inUse.modelId) : undefined;
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const remove = useDeleteAgent();
	const navigate = useNavigate();

	async function deleteAgent() {
		try {
			await remove.mutateAsync(agent.id);
		} catch {
			return;
		}
		await navigate({
			from: "/$workspace",
			to: "./settings/$section",
			params: { section: "agents" },
		});
	}

	return (
		<SettingsPage
			hero={<AgentAvatar color={agent.color} face={agent.face} size={88} />}
			title={agent.name}
			description={pod.name}
		>
			{failure && <Alert>{failure}</Alert>}
			{may.updateAgents && <Look agent={agent} save={save} />}
			<SettingsGroup label="About">
				<TextRow
					label="Name"
					value={agent.name}
					editable={may.updateAgents}
					savePending={savePending}
					maxLength={64}
					required
					onCommit={(name) => save({ name })}
				/>
				<TextRow
					label="Description"
					value={agent.description ?? ""}
					placeholder="One line on what this bot is for."
					editable={may.updateAgents}
					savePending={savePending}
					maxLength={280}
					onCommit={(description) => save({ description })}
				/>
				<SettingsRow
					label="Model"
					trailing={<SettingsValue>{modelName ?? agent.model ?? "None chosen"}</SettingsValue>}
					chevron
					onClick={onOpenModel}
				/>
				<SettingsRow
					label="Instructions"
					trailing={<SettingsValue>{may.updateAgents ? "Edit" : "View"}</SettingsValue>}
					chevron
					onClick={onOpenInstructions}
				/>
			</SettingsGroup>
			<Tools agent={agent} pod={pod} canChange={may.updateAgents} save={save} />
			<section
				id="routines"
				ref={(element) => {
					if (initialTab === "routines") element?.scrollIntoView();
				}}
			>
				<AgentRoutines agent={agent} pod={pod} />
			</section>
			{may.deleteAgents && (
				<SettingsDanger onClick={() => setConfirmingDelete(true)}>Delete bot</SettingsDanger>
			)}
			<DeleteDialog
				open={confirmingDelete}
				onOpenChange={setConfirmingDelete}
				title={`Delete ${agent.name}?`}
				description="Its chat, routines and settings go with it. This can't be undone."
				pending={remove.isPending}
				error={remove.error ? failureMessage(remove.error) : undefined}
				onDelete={deleteAgent}
			/>
		</SettingsPage>
	);
}

/** The bot's colour and eyes, each saved the moment it is picked. */
function Look({ agent, save }: { agent: Agent; save: Save }) {
	return (
		<SettingsGroup label="Look">
			<div className="flex items-center gap-3 border-border border-b px-4 py-3">
				<span className="w-14 shrink-0 text-[14px] text-muted-foreground">Colour</span>
				<ColourPicker
					value={agent.color}
					onChange={(color) => void save({ color }).catch(() => {})}
				/>
			</div>
			<div className="flex items-center gap-3 px-4 py-2.5">
				<span className="w-14 shrink-0 text-[14px] text-muted-foreground">Eyes</span>
				<EyesPicker
					color={agent.color}
					value={agent.face}
					onChange={(face) => void save({ face }).catch(() => {})}
				/>
			</div>
		</SettingsGroup>
	);
}

/** A labelled line of text that saves when you leave it, or reads as a value when it cannot change. */
function TextRow({
	label,
	value,
	placeholder,
	editable,
	savePending,
	maxLength,
	required = false,
	onCommit,
}: {
	label: string;
	value: string;
	placeholder?: string;
	editable: boolean;
	savePending: boolean;
	maxLength: number;
	required?: boolean;
	onCommit: (value: string) => Promise<unknown>;
}) {
	const [draft, setDraft] = useState(value);
	const id = useId();

	function commit() {
		const next = draft.trim();
		if (savePending || next === value || (required && next === "")) {
			setDraft(value);
			return;
		}
		void onCommit(next).catch(() => setDraft(value));
	}

	return (
		<div className="flex items-center gap-3 border-border border-b px-4 py-3 last:border-b-0">
			<label htmlFor={id} className="w-[110px] shrink-0 text-[14px] text-muted-foreground">
				{label}
			</label>
			{editable ? (
				<input
					id={id}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
						if (event.key === "Escape") setDraft(value);
					}}
					placeholder={placeholder}
					maxLength={maxLength}
					className="min-w-0 flex-1 rounded-md bg-transparent text-[14.5px] text-foreground outline-none placeholder:text-subtle-foreground focus-visible:shadow-(--ring-shadow)"
				/>
			) : (
				<span id={id} className="min-w-0 flex-1 text-[14.5px] text-soft-foreground">
					{value || <span className="text-subtle-foreground">None yet</span>}
				</span>
			)}
		</div>
	);
}

const countFormat = new Intl.NumberFormat("en");

function Instructions({
	agent,
	editable,
	back,
	save,
	savePending,
	failure,
}: {
	agent: Agent;
	editable: boolean;
	back: React.ReactNode;
	save: Save;
	savePending: boolean;
	failure: string | undefined;
}) {
	const [draft, setDraft] = useState(agent.prompt);
	const id = useId();
	const dirty = draft !== agent.prompt;

	return (
		<SettingsPage
			back={back}
			title="Instructions"
			description={`How ${agent.name} should work. It follows these in every chat.`}
		>
			{failure && <Alert>{failure}</Alert>}
			<SettingsGroup
				className="p-1"
				note={
					editable
						? `Write it like a note to a new teammate: what it's for, how to sound, and what to never do. ${countFormat.format(draft.length)} of ${countFormat.format(PROMPT_MAX_LENGTH)} characters.`
						: undefined
				}
			>
				<label htmlFor={id} className="sr-only">
					Instructions
				</label>
				<textarea
					id={id}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					readOnly={!editable}
					maxLength={PROMPT_MAX_LENGTH}
					placeholder="No instructions yet."
					className="block min-h-[380px] w-full resize-y rounded-[12px] bg-transparent p-3.5 text-[14.5px] text-foreground leading-[1.65] outline-none placeholder:text-subtle-foreground focus-visible:shadow-(--ring-shadow)"
				/>
			</SettingsGroup>
			{editable && (
				<div className="flex justify-end">
					<Button
						disabled={!dirty || savePending}
						onClick={() => void save({ prompt: draft }).catch(() => {})}
					>
						{savePending ? "Saving…" : "Save"}
					</Button>
				</div>
			)}
		</SettingsPage>
	);
}

/**
 * What the bot can reach: the product's own tools, each of which can be
 * switched off for it, then the pod's connections, which every bot in the pod
 * shares and which are managed on the pod. The built-in tools all reach the
 * web, so while web search is off for the workspace they are off for every bot
 * and cannot be switched on here.
 */
function Tools({
	agent,
	pod,
	canChange,
	save,
}: {
	agent: Agent;
	pod: Pod;
	canChange: boolean;
	save: Save;
}) {
	const backToAgent = useBackToHere(agent.name);
	const connections = useConnections(pod.id);
	const { agents } = useAgents();
	const [openConnectionId, setOpenConnectionId] = useState<string>();
	const webOff = useWebAccess().data?.enabled === false;
	const webOffReason = useWorkspacePermissions().manageProviders
		? "Off for the workspace. Turn on web search in settings."
		: "Off for the workspace. Ask an admin to turn on web search.";
	const podBots =
		agents?.filter((one) => one.podId === pod.id && one.systemAgentKey === null) ?? [];
	const reachable = connections.data?.filter((connection) => connection.access !== "off") ?? [];

	return (
		<SettingsGroup label="Tools">
			<SettingsRow
				icon={<PodTile bots={podBots} size={30} />}
				label={`Tools from ${pod.name}`}
				sub="Every bot in the pod shares these"
				trailing={<span className="shrink-0 font-medium text-[13.5px] text-link">Edit</span>}
				render={<Link {...podSettingsLink(pod)} state={backToAgent} />}
			/>
			{connections.isError && (
				<div className="border-border border-b px-4 py-3">
					<Alert>{failureMessage(connections.error)}</Alert>
				</div>
			)}
			{reachable.map((connection) => {
				const tools = agentToolsOf(connection);
				const available = tools.length;
				const presetId = connectionPresetFor(connection.url)?.id;
				return (
					<div key={connection.id}>
						<SettingsRow
							icon={<ConnectionMark presetId={presetId} name={connection.name} size="sm" />}
							label={connection.name}
							sub={`${available} ${available === 1 ? "tool" : "tools"}`}
							chevron
							onClick={() => setOpenConnectionId(connection.id)}
						/>
						<AgentToolsDialog
							agentName={agent.name}
							connection={connection}
							tools={tools}
							presetId={presetId}
							open={openConnectionId === connection.id}
							onOpenChange={(open) => setOpenConnectionId(open ? connection.id : undefined)}
						/>
					</div>
				);
			})}
			{builtInToolCatalog.map((entry) => {
				const on = !webOff && !agent.disabledTools.includes(entry.key);
				return (
					<SettingsRow
						key={entry.key}
						label={entry.name}
						sub={webOff ? webOffReason : entry.description}
						trailing={
							canChange ? (
								<Toggle
									checked={on}
									disabledReason={webOff ? webOffReason : undefined}
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
								<SettingsValue>{on ? "On" : "Off"}</SettingsValue>
							)
						}
					/>
				);
			})}
		</SettingsGroup>
	);
}
