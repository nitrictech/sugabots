import { botColors } from "@sugabots/avatars";
import {
	type Agent,
	type AgentUpdate,
	type BuiltInToolKey,
	builtInToolCatalog,
	connectionMarkFor,
	DESCRIPTION_MAX_LENGTH,
	type Pod,
	PROMPT_MAX_LENGTH,
} from "@sugabots/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowUpRight, Pencil } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { useDeleteAgent, useModelName, useUpdateAgent } from "@/lib/agents.ts";
import { usableToolCount, useConnections } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { podSettingsPageLink } from "@/lib/links.ts";
import { useSandboxAccess } from "@/lib/sandbox-providers.ts";
import { useWebAccess } from "@/lib/search-provider.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspace, useWorkspaceMembers } from "@/lib/workspace.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { type Look, LookStep, type Part } from "@/shell/NewAgent.tsx";
import { Alert } from "@/ui/alert.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog.tsx";
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
import { AgentRoutines } from "./RoutineEditing.tsx";

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
}: {
	agent: Agent;
	/** The pod this bot lives in, and what the viewer may do in it. */
	pod: Pod;
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
			<SettingsPage
				back={back}
				backOnWide
				title="Model"
				description={`What ${agent.name} thinks with.`}
			>
				{failure && <Alert>{failure}</Alert>}
				<AgentModelPicker
					agentName={agent.name}
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
	save,
	savePending,
	failure,
	onOpenModel,
	onOpenInstructions,
}: {
	agent: Agent;
	pod: Pod;
	save: Save;
	savePending: boolean;
	failure: string | undefined;
	onOpenModel: () => void;
	onOpenInstructions: () => void;
}) {
	const may = pod.permissions;
	const modelName = useModelName(agent.model);
	const workspaceName = useWorkspace().workspace?.name ?? "the workspace";
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const remove = useDeleteAgent();
	const navigate = useNavigate();

	async function deleteAgent() {
		try {
			await remove.mutateAsync(agent.id);
		} catch {
			return;
		}
		await navigate(podSettingsPageLink(pod, "bots"));
	}

	return (
		<SettingsPage
			hero={
				may.updateAgents ? (
					<EditableFace agent={agent} save={save} savePending={savePending} />
				) : (
					<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={44} />
				)
			}
			title={agent.name}
			description={agent.description || undefined}
		>
			{failure && <Alert>{failure}</Alert>}
			<SettingsGroup label="Profile">
				<ProfileField
					label="Name"
					value={agent.name}
					maxLength={AGENT_NAME_MAX_LENGTH}
					required
					editable={may.updateAgents}
					savePending={savePending}
					onCommit={(name) => save({ name })}
				/>
				<ProfileField
					label="Description"
					value={agent.description ?? ""}
					placeholder="One line on what it's for"
					maxLength={DESCRIPTION_MAX_LENGTH}
					wide
					editable={may.updateAgents}
					savePending={savePending}
					onCommit={(description) => save({ description })}
				/>
				<SettingsRow
					label="Model"
					sub={`From the models set up for ${workspaceName}`}
					trailing={<SettingsValue>{modelName ?? "None chosen"}</SettingsValue>}
					chevron
					onClick={onOpenModel}
				/>
				<SettingsRow
					label="Instructions"
					sub="How it should behave and what to focus on"
					chevron
					onClick={onOpenInstructions}
				/>
				<AddedByRow agent={agent} />
			</SettingsGroup>
			<BuiltInTools
				agent={agent}
				pod={pod}
				workspaceName={workspaceName}
				canChange={may.updateAgents}
				save={save}
			/>
			<InheritedTools agent={agent} pod={pod} />
			<AgentRoutines agent={agent} pod={pod} />
			{may.deleteAgents && (
				<SettingsDanger
					label="Delete bot"
					description="Its chat, routines and settings go with it."
					action="Delete"
					onClick={() => setConfirmingDelete(true)}
				/>
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
 * The bot's face, which opens its look when clicked, as the pencil on its
 * corner says. A face nobody may change is only a picture.
 */
function EditableFace({
	agent,
	save,
	savePending,
}: {
	agent: Agent;
	save: Save;
	savePending: boolean;
}) {
	const [editing, setEditing] = useState(false);
	return (
		<>
			<button
				type="button"
				aria-label="Change look"
				onClick={() => setEditing(true)}
				className="focus-ring group/face relative shrink-0 rounded-full"
			>
				<AgentAvatar color={agent.color} face={agent.face} shape={agent.shape} size={44} />
				<span
					aria-hidden
					// Cut out of the face by a ring of the page's own colour.
					className="absolute -right-1.5 -bottom-1.5 grid size-[22px] place-items-center rounded-full border-2 border-background bg-chip text-muted-foreground transition-colors group-hover/face:bg-hover group-hover/face:text-foreground"
				>
					<Pencil size={11} strokeWidth={2.2} />
				</span>
			</button>
			<Dialog open={editing} onOpenChange={setEditing}>
				{editing && (
					<LookEditor
						agent={agent}
						save={save}
						savePending={savePending}
						done={() => setEditing(false)}
					/>
				)}
			</Dialog>
		</>
	);
}

/**
 * The bot's look, laid out as New bot's is but quieter: the bot on a faint
 * tint of its colour, and its shape, eyes and colour beside it. Nothing is
 * saved until Save; Cancel, Escape or a click outside leaves it as it was.
 */
function LookEditor({
	agent,
	save,
	savePending,
	done,
}: {
	agent: Agent;
	save: Save;
	savePending: boolean;
	done: () => void;
}) {
	const [look, setLook] = useState<Look>({
		color: agent.color,
		shape: agent.shape,
		face: agent.face,
	});
	const [part, setPart] = useState<Part>("shape");
	const [failure, setFailure] = useState<string>();
	const change: AgentUpdate = {
		...(look.color !== agent.color && { color: look.color }),
		...(look.shape !== agent.shape && { shape: look.shape }),
		...(look.face !== agent.face && { face: look.face }),
	};
	const changed = Object.keys(change).length > 0;

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!changed) return;
		setFailure(undefined);
		try {
			await save(change);
			done();
		} catch (error) {
			setFailure(failureMessage(error));
		}
	}

	return (
		<DialogContent
			sheetOnPhone
			showCloseButton={false}
			className="max-h-[calc(100dvh-20px)] gap-0 overflow-hidden p-0 sm:max-w-[680px]"
		>
			<DialogTitle className="sr-only">{agent.name}'s look</DialogTitle>
			<form
				onSubmit={submit}
				className="flex min-h-0 min-w-0 flex-col max-md:overflow-y-auto md:h-[460px] md:flex-row"
			>
				<div
					className="flex shrink-0 flex-col gap-4 p-6 transition-colors md:w-[260px]"
					// A fainter tint than New bot's, so the bot is in its own light without shouting.
					style={{
						background: `color-mix(in oklab, ${botColors[look.color].face} 5%, var(--list))`,
					}}
				>
					<div className="grid flex-1 place-items-center py-2">
						<AgentAvatar color={look.color} face={look.face} shape={look.shape} size={88} />
					</div>
					{failure && <Alert>{failure}</Alert>}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="secondary" size="sm" onClick={done}>
							Cancel
						</Button>
						<Button type="submit" size="sm" disabled={!changed || savePending}>
							{savePending ? "Saving…" : "Save"}
						</Button>
					</div>
				</div>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col border-border bg-panel max-md:border-t md:border-l">
					<LookStep
						part={part}
						look={look}
						onPartChange={setPart}
						onChange={(parts) => setLook((was) => ({ ...was, ...parts }))}
					/>
				</div>
			</form>
		</DialogContent>
	);
}

/**
 * Who added the bot, with their face, and when. Somebody since gone from the
 * workspace is named as such rather than left blank; a bot nobody added was
 * made with the workspace.
 */
function AddedByRow({ agent }: { agent: Agent }) {
	const { data: members } = useWorkspaceMembers(agent.workspaceId);
	const adder = members?.find((member) => member.user.id === agent.createdById)?.user;
	const when = new Date(agent.createdAt).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
	// Said once the roster has answered, rather than guessed before it.
	const who =
		agent.createdById === null
			? "With the workspace"
			: adder
				? adder.name
				: members
					? "Someone no longer here"
					: undefined;
	return (
		<SettingsRow
			label="Added by"
			sub={when}
			trailing={
				who !== undefined && (
					<span className="flex min-w-0 items-center gap-2">
						{adder && <PersonAvatar person={adder} size={20} />}
						<SettingsValue>{who}</SettingsValue>
					</span>
				)
			}
		/>
	);
}

/** How long a name may be, as New bot holds it. */
const AGENT_NAME_MAX_LENGTH = 64;

/**
 * A line of the bot's profile in a field at the row's end, which saves trimmed
 * when you leave it or press Enter. Escape, or leaving it unchanged, or blank
 * when it is `required`, puts it back; so does a save that fails. `wide`
 * gives the field the rest of the row, for a line longer than a name.
 */
function ProfileField({
	label,
	value,
	placeholder,
	maxLength,
	required = false,
	wide = false,
	editable,
	savePending,
	onCommit,
}: {
	label: string;
	value: string;
	placeholder?: string;
	maxLength: number;
	required?: boolean;
	wide?: boolean;
	editable: boolean;
	savePending: boolean;
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
		setDraft(next);
		void onCommit(next).catch(() => setDraft(value));
	}

	return (
		<div className="flex min-h-14 items-center gap-3.5 border-border border-b px-4 py-2.5 last:border-b-0">
			<label
				htmlFor={id}
				className={cn("text-[13px] text-foreground", wide ? "w-24 shrink-0" : "flex-1")}
			>
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
					className={cn(
						"h-8 min-w-0 rounded-md border border-border-strong bg-settings-row-hover px-2.5 text-[13px] text-foreground outline-none placeholder:text-subtle-foreground focus-visible:border-ring",
						wide ? "flex-1" : "w-60 max-w-[50%]",
					)}
				/>
			) : (
				<span id={id} className={cn("min-w-0 text-[13px] text-muted-foreground", wide && "flex-1")}>
					{value || "None yet"}
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
			backOnWide
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
					className="block min-h-[380px] w-full resize-y rounded-[12px] bg-transparent p-3.5 text-[13px] text-foreground leading-[1.65] outline-none placeholder:text-subtle-foreground focus-visible:shadow-(--ring-shadow)"
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

/** The tools that reach the web, which one switch turns on and off together: Web search. */
const WEB_TOOLS: readonly BuiltInToolKey[] = builtInToolCatalog
	.filter((entry) => entry.usesWeb)
	.map((entry) => entry.key);

/**
 * The tools `agent` has from its pod's connections, which every bot in the pod
 * shares. They are only shown here: what each allows is set on the pod, which
 * Edit beside the heading leads to. A connection whose tools are all off gives
 * the bot nothing, so it is left out.
 */
function InheritedTools({ agent, pod }: { agent: Agent; pod: Pod }) {
	const backToAgent = useBackToHere(agent.name);
	const connections = useConnections(pod.id);
	const reachable = connections.data?.filter((connection) => usableToolCount(connection) > 0);
	return (
		<SettingsGroup
			label={`Inherited from ${pod.name}`}
			action={
				<Link
					{...podSettingsPageLink(pod, "connections")}
					state={backToAgent}
					className="focus-ring flex items-center gap-0.5 rounded-sm text-[13px] text-muted-foreground transition-colors hover:text-foreground"
				>
					Edit in {pod.name}
					<ArrowUpRight aria-hidden size={13} strokeWidth={2} />
				</Link>
			}
			note={`Every bot in ${pod.name} shares these. What each connection allows is set on the pod.`}
		>
			{connections.isError && (
				<div className="px-4 py-3">
					<Alert>{failureMessage(connections.error)}</Alert>
				</div>
			)}
			{reachable?.length === 0 && (
				<SettingsRow label={<span className="text-muted-foreground">No connections yet</span>} />
			)}
			{reachable?.map((connection) => {
				const tools = usableToolCount(connection);
				return (
					<SettingsRow
						key={connection.id}
						icon={
							<ConnectionMark
								presetId={connectionMarkFor(connection)}
								name={connection.name}
								size="md"
							/>
						}
						label={connection.name}
						sub={`${tools} ${tools === 1 ? "tool" : "tools"}`}
						trailing={<SettingsValue>Inherited</SettingsValue>}
					/>
				);
			})}
		</SettingsGroup>
	);
}

/**
 * The tools `agent` has of its own, rather than from its pod's connections:
 * its computer, the web, and the rest of the catalog, each of which can be
 * switched off for it. The computer and the web are set up for the workspace
 * first; until they are, each says so and leads to where an admin sets it up.
 */
function BuiltInTools({
	agent,
	pod,
	workspaceName,
	canChange,
	save,
}: {
	agent: Agent;
	pod: Pod;
	workspaceName: string;
	canChange: boolean;
	save: Save;
}) {
	const webOff = useWebAccess().data?.enabled === false;
	const computersOff = useSandboxAccess().data?.enabled === false;
	const isOn = (keys: readonly BuiltInToolKey[]) =>
		keys.some((key) => !agent.disabledTools.includes(key));
	const setTools = (keys: readonly BuiltInToolKey[], on: boolean) =>
		save({
			disabledTools: on
				? agent.disabledTools.filter((key) => !(keys as readonly string[]).includes(key))
				: [...new Set([...agent.disabledTools, ...keys])],
		}).catch(() => {});

	return (
		<SettingsGroup label="Built-in tools">
			<ToolRow
				label="Computer"
				sub={
					computersOff
						? `Computers are off for ${workspaceName}`
						: "Run commands, browse and edit files on the pod's computer"
				}
				on={agent.usesSandbox && !computersOff}
				canChange={pod.permissions.manageSandbox}
				offReason={computersOff ? `Computers are off for ${workspaceName}` : undefined}
				onChange={(next) => save({ usesSandbox: next }).catch(() => {})}
			/>
			{/* How it uses its computer's browser, so only while it has one. */}
			{agent.usesSandbox && !computersOff && (
				<ToolRow
					label="Natural browsing"
					sub="Show a cursor, scroll smoothly and type at a typing pace, so people watching can follow along. Slower."
					on={agent.naturalBrowsing}
					canChange={canChange}
					onChange={(next) => save({ naturalBrowsing: next }).catch(() => {})}
				/>
			)}
			<ToolRow
				label="Web search"
				sub={webOff ? `Web search is off for ${workspaceName}` : "Look things up and cite pages"}
				on={isOn(WEB_TOOLS) && !webOff}
				canChange={canChange}
				offReason={webOff ? `Web search is off for ${workspaceName}` : undefined}
				onChange={(next) => setTools(WEB_TOOLS, next)}
			/>
			{builtInToolCatalog
				.filter((entry) => !entry.usesWeb)
				.map((entry) => (
					<ToolRow
						key={entry.key}
						label={entry.name}
						sub={entry.description}
						on={isOn([entry.key])}
						canChange={canChange}
						onChange={(next) => setTools([entry.key], next)}
					/>
				))}
		</SettingsGroup>
	);
}

/**
 * A tool the bot may have, with its switch, or whether it is on for someone
 * who can't change it. Given `offReason`, the switch is held off and disabled,
 * and says why when pointed at.
 */
function ToolRow({
	label,
	sub,
	on,
	canChange,
	offReason,
	onChange,
}: {
	label: string;
	sub: string;
	on: boolean;
	canChange: boolean;
	offReason?: string;
	onChange: (on: boolean) => void;
}) {
	return (
		<SettingsRow
			label={offReason ? <span className="text-muted-foreground">{label}</span> : label}
			sub={sub}
			trailing={
				canChange ? (
					<Toggle
						checked={on}
						disabled={offReason !== undefined}
						tooltip={offReason}
						label={`${on ? "Turn off" : "Turn on"} ${label}`}
						onChange={onChange}
					/>
				) : (
					<SettingsValue>{on ? "On" : "Off"}</SettingsValue>
				)
			}
		/>
	);
}
