import {
	type Agent,
	type AgentUpdate,
	agentColors,
	agentFaces,
	agentShapes,
	builtInToolCatalog,
	connectionMarkFor,
	type Pod,
	PROMPT_MAX_LENGTH,
} from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { MessageCircle, Pencil, RefreshCw } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { useAgents, useDeleteAgent, useRunsOnLabel, useUpdateAgent } from "@/lib/agents.ts";
import { usableToolCount, useConnections } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { agentChatLink, connectionSettingsLink, podSettingsLink } from "@/lib/links.ts";
import { useSandboxAccess } from "@/lib/sandbox-providers.ts";
import { useWebAccess } from "@/lib/search-provider.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { LookSections } from "@/shell/LookPicker.tsx";
import { PodTile } from "@/shell/PodTile.tsx";
import {
	type A2ADraft,
	A2AEndpointFields,
	a2aEndpointOf,
	type RunsOn,
	RunsOnControl,
} from "@/shell/RunsOn.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import {
	PageBackLink,
	SettingsControlRow,
	SettingsDanger,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { AgentModelPicker } from "./AgentModelPicker.tsx";
import { AgentRoutines } from "./RoutinesSettings.tsx";

/*
 * One bot, as its contact card: its face and colour first, then what it is,
 * what it runs on and what it is told, what it can reach, and what it does
 * unprompted. What it runs on and its instructions each open on a page of
 * their own in the same place, so the card never rearranges under you. A bot
 * standing for an external agent has no instructions or tools of ours to show.
 *
 * What can be changed comes from the pod's resolved permissions, and a control
 * nobody may use is not drawn. Each field saves on its own; instructions are
 * prose somebody may be part-way through, so they wait for Save.
 */
export function AgentSettingsPage({
	agent,
	pod,
}: {
	agent: Agent;
	/** The pod this bot lives in, and what the viewer may do in it. */
	pod: Pod;
}) {
	const [page, setPage] = useState<"card" | "runs-on" | "instructions">("card");
	const update = useUpdateAgent(agent.id);
	const failure = update.error ? failureMessage(update.error) : undefined;
	const back = (
		<PageBackLink
			label={agent.name}
			render={<button type="button" onClick={() => setPage("card")} />}
		/>
	);

	if (page === "runs-on") {
		return (
			<RunsOnPage
				agent={agent}
				editable={pod.permissions.updateAgents}
				back={back}
				save={update.mutateAsync}
				savePending={update.isPending}
				failure={failure}
				done={() => setPage("card")}
			/>
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
			save={update.mutateAsync}
			savePending={update.isPending}
			failure={failure}
			onOpenRunsOn={() => setPage("runs-on")}
			onOpenInstructions={() => setPage("instructions")}
		/>
	);
}

type Save = (change: AgentUpdate) => Promise<unknown>;

function ContactCard({
	agent,
	pod,
	save,
	savePending,
	failure,
	onOpenRunsOn,
	onOpenInstructions,
}: {
	agent: Agent;
	pod: Pod;
	save: Save;
	savePending: boolean;
	failure: string | undefined;
	onOpenRunsOn: () => void;
	onOpenInstructions: () => void;
}) {
	const may = pod.permissions;
	const runsOn = useRunsOnLabel(agent);
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
			hero={
				may.updateAgents ? (
					<EditableLook agent={agent} save={save} />
				) : (
					<AgentAvatar
						color={agent.color}
						face={agent.face}
						shape={agent.shape}
						size={88}
						external={agent.a2a !== null}
					/>
				)
			}
			title={agent.name}
			description={pod.name}
			headerAction={
				<Link {...agentChatLink({ pod, agent })} className={buttonStyles({ size: "sm" })}>
					<MessageCircle aria-hidden />
					Message
				</Link>
			}
		>
			{failure && <Alert>{failure}</Alert>}
			<SettingsGroup
				label="About"
				note={
					agent.a2a &&
					`Replies come from the external agent at ${hostOf(agent.a2a.url)}, which brings its own model, instructions and tools.`
				}
			>
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
					label="Runs on"
					trailing={<SettingsValue>{runsOn}</SettingsValue>}
					chevron
					onClick={onOpenRunsOn}
				/>
				{!agent.a2a && (
					<SettingsRow
						label="Instructions"
						trailing={<SettingsValue>{may.updateAgents ? "Edit" : "View"}</SettingsValue>}
						chevron
						onClick={onOpenInstructions}
					/>
				)}
			</SettingsGroup>
			{!agent.a2a && <Tools agent={agent} pod={pod} canChange={may.updateAgents} save={save} />}
			<AgentRoutines agent={agent} pod={pod} />
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

/**
 * The bot's face, with a pencil on its corner that opens its colour, shape and
 * eyes. Each is saved the moment it is picked; Shuffle picks all three at
 * random, and Revert puts back the look it had when the dialog opened.
 */
/**
 * The bot's face, with a pencil that opens its Look. Choices there change a
 * draft the dialog's own face shows, and only Save sends it; leaving any other
 * way, by Cancel, Escape or a click outside, drops it.
 */
function EditableLook({ agent, save }: { agent: Agent; save: Save }) {
	const [opened, setOpened] = useState(false);
	const current: Look = { color: agent.color, shape: agent.shape, face: agent.face };
	// Kept once the dialog closes, so it still shows the draft as it animates away.
	const [draft, setDraft] = useState<Look>(current);
	const [saving, setSaving] = useState(false);
	const [failure, setFailure] = useState<string>();
	// Cancel takes focus on opening, rather than Shuffle, the first control, whose tooltip would show.
	const cancel = useRef<HTMLButtonElement>(null);
	const changed =
		draft.color !== current.color || draft.shape !== current.shape || draft.face !== current.face;

	const open = () => {
		setFailure(undefined);
		setDraft(current);
		setOpened(true);
	};
	const close = () => setOpened(false);
	const change = (look: Partial<Look>) => setDraft((was) => ({ ...was, ...look }));
	const saveDraft = async () => {
		setSaving(true);
		setFailure(undefined);
		try {
			await save(draft);
			close();
		} catch (error) {
			setFailure(failureMessage(error));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="relative">
			<AgentAvatar {...current} size={88} external={agent.a2a !== null} />
			<IconButton
				label="Change look"
				variant="round"
				onClick={open}
				// The ring cutting it out of the face is a border rather than a shadow: the button's fill runs under its own border, so no hairline of the face shows between them.
				className="absolute -right-[7px] -bottom-[7px] size-[35px] border-[3px] border-background"
			>
				<Pencil aria-hidden />
			</IconButton>
			<Dialog open={opened} onOpenChange={(isOpen) => !isOpen && close()}>
				<DialogContent
					sheetOnPhone
					showCloseButton={false}
					initialFocus={cancel}
					className="gap-5 sm:max-w-md"
				>
					<div className="flex items-center gap-3">
						<AgentAvatar {...draft} size={36} />
						<DialogTitle className="flex-1">Look</DialogTitle>
						<IconButton label="Shuffle" variant="round" onClick={() => change(randomLook())}>
							<RefreshCw aria-hidden />
						</IconButton>
					</div>
					<LookSections
						{...draft}
						onColorChange={(color) => change({ color })}
						onShapeChange={(shape) => change({ shape })}
						onFaceChange={(face) => change({ face })}
					/>
					{failure && <Alert>{failure}</Alert>}
					<div className="flex justify-end gap-2">
						<Button ref={cancel} variant="secondary" onClick={close}>
							Cancel
						</Button>
						<Button disabled={!changed || saving} onClick={() => void saveDraft()}>
							Save
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

type Look = Pick<Agent, "color" | "shape" | "face">;

const pick = <Option,>(options: readonly Option[]): Option =>
	options[Math.floor(Math.random() * options.length)] as Option;

function randomLook(): Look {
	return { color: pick(agentColors), shape: pick(agentShapes), face: pick(agentFaces) };
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
		<SettingsControlRow label={label} htmlFor={id}>
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
					className="-mx-1 -my-1 min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-[14.5px] text-foreground outline-none placeholder:text-subtle-foreground focus-visible:shadow-(--ring-shadow)"
				/>
			) : (
				<span id={id} className="min-w-0 flex-1 text-[14.5px] text-soft-foreground">
					{value || <span className="text-subtle-foreground">None yet</span>}
				</span>
			)}
		</SettingsControlRow>
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

/** The host of `url`, which is how an address is shown in a row. */
function hostOf(url: string) {
	return URL.canParse(url) ? new URL(url).host : url;
}

/**
 * What answers as the bot: one of the workspace's models, chosen from the
 * list and saved as it is picked, or another service's agent over A2A, whose
 * address and secret are saved together. Choosing a model for a bot on an A2A
 * agent takes it off the agent. A saved secret is never shown; leaving the
 * field empty keeps it, as long as the header stays the same.
 */
function RunsOnPage({
	agent,
	editable,
	back,
	save,
	savePending,
	failure,
	done,
}: {
	agent: Agent;
	editable: boolean;
	back: React.ReactNode;
	save: Save;
	savePending: boolean;
	failure: string | undefined;
	done: () => void;
}) {
	const [runsOn, setRunsOn] = useState<RunsOn>(agent.a2a ? "a2a" : "model");
	const [draft, setDraft] = useState<A2ADraft>({
		url: agent.a2a?.url ?? "",
		secretHeader: agent.a2a?.secretHeader ?? "",
		secret: "",
	});
	const endpoint = a2aEndpointOf(draft);
	const keepsSecret =
		agent.a2a?.hasSecret === true && draft.secretHeader.trim() === (agent.a2a.secretHeader ?? "");

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!endpoint) return;
		try {
			await save({ a2a: endpoint });
		} catch {
			return;
		}
		done();
	}

	return (
		<SettingsPage
			back={back}
			title="Runs on"
			description={`What answers as ${agent.name}: one of the workspace's models, or an external agent another service runs, reached over the Agent2Agent (A2A) protocol, with its own model, instructions and tools.`}
		>
			{failure && <Alert>{failure}</Alert>}
			{editable && (
				<SettingsGroup>
					<RunsOnControl value={runsOn} onChange={setRunsOn} />
				</SettingsGroup>
			)}
			{runsOn === "model" ? (
				<AgentModelPicker
					agentName={agent.name}
					model={agent.a2a ? null : agent.model}
					canChoose={editable}
					onChoose={(model) => {
						void save({ model, ...(agent.a2a ? { a2a: null } : {}) }).catch(() => {});
					}}
				/>
			) : editable ? (
				<form onSubmit={(event) => void submit(event)} className="flex flex-col gap-6">
					<A2AEndpointFields draft={draft} onChange={setDraft} keepsSecret={keepsSecret} />
					<div className="flex justify-end">
						<Button type="submit" disabled={!endpoint || savePending}>
							{savePending ? "Saving…" : "Save"}
						</Button>
					</div>
				</form>
			) : (
				<SettingsGroup>
					<SettingsRow
						label="External agent"
						trailing={<SettingsValue>{agent.a2a?.url}</SettingsValue>}
					/>
				</SettingsGroup>
			)}
		</SettingsPage>
	);
}

/**
 * Tools lists what `agent` can reach: the pod's connections, which every bot in
 * `pod` shares and which are managed on the pod, then the built-in tools, each
 * of which can be switched off for `agent`. Every built-in tool reaches the
 * web, so while the workspace has web access off they show as off and
 * disabled, and the group's note says how to turn web access on.
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
	const webOff = useWebAccess().data?.enabled === false;
	const sandboxOff = useSandboxAccess().data?.enabled === false;
	const mayManageProviders = useWorkspacePermissions().manageProviders;
	const podBots =
		agents?.filter((one) => one.podId === pod.id && one.systemAgentKey === null) ?? [];
	const reachable = connections.data?.filter((connection) => usableToolCount(connection) > 0) ?? [];

	return (
		<SettingsGroup
			label="Tools"
			note={
				webOff && (
					<>
						Bots can't read or search the web while it's off for the workspace.{" "}
						{mayManageProviders ? (
							<Link
								from="/$workspace"
								to="./settings/$section"
								params={{ section: "search" }}
								state={backToAgent}
								className="focus-ring rounded-sm font-medium text-link"
							>
								Turn it on in Web search
							</Link>
						) : (
							"Ask a workspace admin to turn it on."
						)}
					</>
				)
			}
		>
			<SettingsRow
				icon={<PodTile bots={podBots} color={pod.color} size={30} />}
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
				const available = usableToolCount(connection);
				return (
					<SettingsRow
						key={connection.id}
						icon={
							<ConnectionMark
								presetId={connectionMarkFor(connection)}
								name={connection.name}
								size="sm"
							/>
						}
						label={connection.name}
						sub={`${available} ${available === 1 ? "tool" : "tools"}`}
						chevron
						render={<Link {...connectionSettingsLink(pod, connection)} state={backToAgent} />}
					/>
				);
			})}
			{builtInToolCatalog.map((entry) => {
				const blocked = webOff && entry.usesWeb;
				const on = !blocked && !agent.disabledTools.includes(entry.key);
				return (
					<SettingsRow
						key={entry.key}
						label={entry.name}
						sub={entry.description}
						trailing={
							canChange ? (
								<Toggle
									checked={on}
									disabled={blocked}
									label={`${on ? "Turn off" : "Turn on"} ${entry.name}`}
									tooltip={
										blocked
											? mayManageProviders
												? "Disabled while web access is off for the workspace. Turn it on in Web search settings."
												: "Disabled while web access is off for the workspace. Ask a workspace admin to enable it."
											: `Toggle to ${on ? "disable" : "enable"} ${entry.name} for ${agent.name}`
									}
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
			<SettingsRow
				label="Use the sandbox"
				sub="Run commands and edit files on the pod's Linux machine. Experimental."
				trailing={
					pod.permissions.manageSandbox ? (
						<Toggle
							checked={agent.usesSandbox && !sandboxOff}
							disabled={sandboxOff}
							label={`${agent.usesSandbox ? "Turn off" : "Turn on"} the sandbox`}
							tooltip={
								sandboxOff
									? mayManageProviders
										? "Disabled until the workspace has a sandbox provider. Set one up in Sandboxes settings."
										: "Disabled until the workspace has a sandbox provider. Ask a workspace admin to set one up."
									: `Toggle to ${agent.usesSandbox ? "stop" : "let"} ${agent.name} use the sandbox`
							}
							onChange={(next) => save({ usesSandbox: next }).catch(() => {})}
						/>
					) : (
						<SettingsValue>{agent.usesSandbox && !sandboxOff ? "On" : "Off"}</SettingsValue>
					)
				}
			/>
		</SettingsGroup>
	);
}
