import { useRender } from "@base-ui/react/use-render";
import { botPalettes } from "@sugabots/avatars";
import {
	BOT_NAME_MAX_LENGTH,
	type Bot,
	type BotUpdate,
	type BuiltInToolKey,
	builtInToolCatalog,
	connectionMarkFor,
	DESCRIPTION_MAX_LENGTH,
	PROMPT_MAX_LENGTH,
} from "@sugabots/contracts";
import { ProviderLogo } from "@sugabots/provider-logos";
import { Link, linkOptions, useRouter } from "@tanstack/react-router";
import { ArrowUpRight, ChevronDown, Pencil } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { useDeleteBot, useModels, useUpdateBot } from "@/lib/bots.ts";
import { characterCount } from "@/lib/character-count.ts";
import { useComputerAccess } from "@/lib/computer-providers.ts";
import { usableToolCount, useConnections } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { botConnectionsLink, botSettingsPageLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { modelLogoOf } from "@/lib/model-logo.ts";
import { countOf } from "@/lib/name-list.ts";
import { useWebAccess } from "@/lib/search-provider.ts";
import { useSession } from "@/lib/session.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspace } from "@/lib/workspace.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { type Look, LookStep, type Part } from "@/shell/NewBot.tsx";
import { Alert } from "@/ui/alert.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { useLeave } from "@/ui/back-button.tsx";
import { Button } from "@/ui/button.tsx";
import { CloseButton } from "@/ui/close-button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { InstructionsField } from "@/ui/instructions-field.tsx";
import {
	SettingsDanger,
	SettingsGroup,
	SettingsPage,
	SettingsRow,
	SettingsValue,
} from "@/ui/settings-page.tsx";
import { Toggle } from "@/ui/toggle.tsx";
import { useCommittedDraft } from "@/ui/use-committed-draft.ts";
import { BotAutomations } from "./AutomationEditing.tsx";

/*
 * One bot, as its contact card: its face and colour first, then what it is,
 * what it thinks with and what it is told, all open on the page, what it can
 * reach, and what it does unprompted.
 *
 * What can be changed comes from the bot's resolved permissions, and a control
 * nobody may use is not drawn. Each field saves on its own, as you leave it.
 */
export function BotSettingsPage({ bot }: { bot: Bot }) {
	const update = useUpdateBot(bot.id);
	const save: Save = update.mutateAsync;
	const savePending = update.isPending;
	const may = bot.permissions;
	// A Personal Assistant's prompt, model and tools are ours: its person changes its look (name, colour, face, shape) and connections.
	const fixed = bot.assistant;
	const workspaceName = useWorkspace().workspace?.name ?? "the workspace";
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const remove = useDeleteBot();
	const router = useRouter();
	const { leaveForPage } = useLeave();

	async function deleteBot() {
		try {
			await remove.mutateAsync(bot.id);
		} catch {
			return;
		}
		// Back to Bots, or Bots in the deleted bot's place, so Back never returns to it.
		leaveForPage(
			router.buildLocation(
				linkOptions({
					from: "/$workspace",
					to: "./settings/$section",
					params: { section: "bots" },
				}),
			).href,
		);
	}

	return (
		<SettingsPage
			hero={
				may.update ? (
					<EditableFace bot={bot} save={save} savePending={savePending} />
				) : (
					<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={44} />
				)
			}
			title={bot.name}
			description={bot.description || undefined}
		>
			{update.error && <Alert>{failureMessage(update.error)}</Alert>}
			<SettingsGroup label="Profile">
				<ProfileField
					label="Name"
					value={bot.name}
					maxLength={BOT_NAME_MAX_LENGTH}
					required
					editable={may.update}
					savePending={savePending}
					onCommit={(name) => save({ name })}
				/>
				{!fixed && (
					<>
						<ProfileField
							label="Description"
							value={bot.description ?? ""}
							placeholder="One line on what it's for"
							maxLength={DESCRIPTION_MAX_LENGTH}
							editable={may.update}
							savePending={savePending}
							onCommit={(description) => save({ description })}
						/>
						<VisibilityRow bot={bot} editable={may.update} savePending={savePending} save={save} />
						<ModelRow
							model={bot.model}
							canChoose={may.update}
							onChoose={(model) => {
								void save({ model }).catch(() => {});
							}}
						/>
						<AddedByRow bot={bot} />
					</>
				)}
			</SettingsGroup>
			{!fixed && (
				<Instructions bot={bot} editable={may.update} save={save} savePending={savePending} />
			)}
			{!fixed && (
				<BuiltInTools bot={bot} workspaceName={workspaceName} canChange={may.update} save={save} />
			)}
			<BotConnections bot={bot} />
			{!fixed && <BotAutomations bot={bot} />}
			{may.delete && !fixed && (
				<SettingsDanger
					label="Delete bot"
					description="Its threads, automations and settings go with it."
					action="Delete"
					onClick={() => setConfirmingDelete(true)}
				/>
			)}
			<DeleteDialog
				open={confirmingDelete}
				onOpenChange={setConfirmingDelete}
				title={`Delete ${bot.name}?`}
				description="Its threads, automations and settings go with it. This can't be undone."
				pending={remove.isPending}
				error={remove.error ? failureMessage(remove.error) : undefined}
				onDelete={deleteBot}
			/>
		</SettingsPage>
	);
}

type Save = (change: BotUpdate) => Promise<unknown>;

/**
 * The bot's face, which opens its look when clicked, as the pencil on its
 * corner says. A face nobody may change is only a picture.
 */
function EditableFace({ bot, save, savePending }: { bot: Bot; save: Save; savePending: boolean }) {
	const [editing, setEditing] = useState(false);
	return (
		<>
			<button
				type="button"
				aria-label="Change look"
				onClick={() => setEditing(true)}
				className="focus-ring group/face relative shrink-0 rounded-full"
			>
				<BotAvatar color={bot.color} face={bot.face} shape={bot.shape} size={44} />
				<span
					aria-hidden
					// Cut out of the face by a ring of the page's own colour.
					className="absolute -right-1.5 -bottom-1.5 grid size-5.5 place-items-center rounded-full border-2 border-background bg-chip text-muted-foreground transition-colors group-hover/face:bg-hover group-hover/face:text-foreground"
				>
					<Pencil size={11} strokeWidth={2.2} />
				</span>
			</button>
			<Dialog open={editing} onOpenChange={setEditing}>
				{editing && (
					<LookEditor
						bot={bot}
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
	bot,
	save,
	savePending,
	done,
}: {
	bot: Bot;
	save: Save;
	savePending: boolean;
	done: () => void;
}) {
	const [look, setLook] = useState<Look>({
		color: bot.color,
		shape: bot.shape,
		face: bot.face,
	});
	const [part, setPart] = useState<Part>("shape");
	const [failure, setFailure] = useState<string>();
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	const change: BotUpdate = {
		...(look.color !== bot.color && { color: look.color }),
		...(look.shape !== bot.shape && { shape: look.shape }),
		...(look.face !== bot.face && { face: look.face }),
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

	const lookStep = (
		<LookStep
			part={part}
			look={look}
			onPartChange={setPart}
			onChange={(parts) => setLook((was) => ({ ...was, ...parts }))}
		/>
	);
	// A tint of the bot's colour, fainter than New bot's, so the bot is in its own light without shouting.
	const stage = {
		background: `color-mix(in oklab, ${botPalettes[look.color].face} 5%, var(--list))`,
	};

	if (phone) {
		// A page of its own, as New bot's look is: Close and Save across the top, the bot, then its parts.
		return (
			<DialogContent
				showCloseButton={false}
				className="inset-0 flex h-visible max-h-none max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0"
			>
				<DialogTitle className="sr-only">{bot.name}'s look</DialogTitle>
				<form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
					<header
						className="grid shrink-0 grid-cols-centered items-center gap-3 px-4 pt-safe-or-3 pb-2"
						style={stage}
					>
						<span className="flex justify-self-start">
							<CloseButton label="Cancel" onClick={done} />
						</span>
						<span className="font-semibold text-base text-foreground">Look</span>
						<span className="flex justify-self-end">
							<Button
								type="submit"
								size="sm"
								className="h-11 rounded-full px-5 text-sm"
								disabled={!changed || savePending}
							>
								{savePending ? "Saving…" : "Save"}
							</Button>
						</span>
					</header>
					<div className="flex shrink-0 flex-col items-center gap-3 px-4 pt-2 pb-5" style={stage}>
						<BotAvatar color={look.color} face={look.face} shape={look.shape} size={88} />
						{failure && <Alert>{failure}</Alert>}
					</div>
					<div className="flex min-h-0 flex-1 flex-col overflow-y-auto border-border border-t bg-panel">
						{lookStep}
					</div>
				</form>
			</DialogContent>
		);
	}

	return (
		<DialogContent
			showCloseButton={false}
			className="max-h-dialog gap-0 overflow-hidden p-0 sm:max-w-170"
		>
			<DialogTitle className="sr-only">{bot.name}'s look</DialogTitle>
			<form
				onSubmit={submit}
				className="flex min-h-0 min-w-0 flex-col max-md:overflow-y-auto md:h-115 md:flex-row"
			>
				<div className="flex shrink-0 flex-col gap-4 p-6 transition-colors md:w-65" style={stage}>
					<div className="grid flex-1 place-items-center py-2">
						<BotAvatar color={look.color} face={look.face} shape={look.shape} size={88} />
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
				<div className="flex min-h-0 min-w-0 flex-1 flex-col border-border border-l bg-panel">
					{lookStep}
				</div>
			</form>
		</DialogContent>
	);
}

/**
 * Who added the bot, with their face, and when. One with nobody to name reads
 * as made with the workspace: the API tells a bot made at setup from one
 * whose creator's account was since deleted no more than that.
 */
function AddedByRow({ bot }: { bot: Bot }) {
	const adder = bot.createdBy;
	const when = new Date(bot.createdAt).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
	return (
		<SettingsRow
			label="Added by"
			sub={when}
			trailing={
				<span className="flex min-w-0 items-center gap-2">
					{adder && <PersonAvatar person={adder} size={20} />}
					<SettingsValue>{adder?.name ?? "With the workspace"}</SettingsValue>
				</span>
			}
		/>
	);
}

/**
 * A line of the bot's profile in a field taking the rest of its row, after a
 * label as wide as every other's, so the fields line up. It saves trimmed when
 * you leave it or press Enter. Escape, or leaving it unchanged, or blank when
 * it is `required`, puts it back; so does a save that fails.
 */
function ProfileField({
	label,
	value,
	placeholder,
	maxLength,
	required = false,
	editable,
	savePending,
	onCommit,
}: {
	label: string;
	value: string;
	placeholder?: string;
	maxLength: number;
	required?: boolean;
	editable: boolean;
	savePending: boolean;
	onCommit: (value: string) => Promise<unknown>;
}) {
	const { fieldProps } = useCommittedDraft(value, onCommit, {
		allowEmpty: !required,
		pending: savePending,
	});
	const id = useId();

	return (
		<div className="flex min-h-14 items-center gap-3.5 border-border border-b px-4 py-2.5 last:border-b-0">
			<label htmlFor={id} className="w-24 shrink-0 text-sm text-foreground">
				{label}
			</label>
			{editable ? (
				// In a box of its own, so anything put beside the field, as some browser extensions do, can't take room from the row.
				<div className="min-w-0 flex-1">
					<input
						id={id}
						{...fieldProps}
						placeholder={placeholder}
						maxLength={maxLength}
						className="h-8 w-full min-w-0 rounded-md border border-border-strong bg-settings-row-hover px-2.5 text-xs text-foreground outline-none placeholder:text-subtle-foreground focus-visible:border-ring"
					/>
				</div>
			) : (
				<span id={id} className="min-w-0 flex-1 text-xs text-muted-foreground">
					{value || "None yet"}
				</span>
			)}
		</div>
	);
}

/** How the bot should work, written straight into on its card and saved when you leave the box. */
function Instructions({
	bot,
	editable,
	save,
	savePending,
}: {
	bot: Bot;
	editable: boolean;
	save: Save;
	savePending: boolean;
}) {
	const { draft, fieldProps } = useCommittedDraft(bot.prompt, (prompt) => save({ prompt }), {
		allowEmpty: true,
		pending: savePending,
	});

	return (
		<SettingsGroup
			label="Instructions"
			description={`How ${bot.name} should work. It follows these in every thread.`}
			className="p-1"
			note={
				editable
					? `Write it like a note to a new teammate: what it's for, how to sound, and what to never do. ${characterCount(draft.length, PROMPT_MAX_LENGTH)}.${savePending ? " Saving…" : ""}`
					: undefined
			}
		>
			<InstructionsField
				{...fieldProps}
				readOnly={!editable}
				maxLength={PROMPT_MAX_LENGTH}
				placeholder="No instructions yet."
				className="min-h-75"
			/>
		</SettingsGroup>
	);
}

/**
 * The model the bot thinks with, as a row of its profile: the one in use, by
 * its maker's logo and name, which opens the models switched on for the
 * workspace to choose from. A model chosen before it was switched off is still
 * the one in use, and says so under it.
 */
function ModelRow({
	model,
	canChoose,
	onChoose,
}: {
	model: string | null;
	canChoose: boolean;
	onChoose: (model: string) => void;
}) {
	const { data } = useModels();
	const offered = data?.models ?? [];
	const current = offered.find((candidate) => candidate.modelId === model);
	const switchedOff = model !== null && data !== undefined && current === undefined;
	const logo = modelLogoOf(model, current?.providerPreset ?? null);
	return (
		<div className="flex min-h-14 items-center gap-3.5 border-border border-b px-4 py-2.5 last:border-b-0">
			<span className="w-24 shrink-0 text-sm text-foreground">Model</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<DropdownMenu>
					<DropdownMenuTrigger
						disabled={!canChoose}
						aria-label={`Model: ${current?.displayName ?? model ?? "None chosen"}`}
						className="focus-ring flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-border-strong bg-settings-row-hover px-2.5 text-left text-xs text-foreground disabled:cursor-default"
					>
						{logo && <ProviderLogo preset={logo} className="size-3.5" />}
						<span className="min-w-0 flex-1 truncate">
							{current?.displayName ?? model ?? "None chosen"}
						</span>
						{canChoose && (
							<ChevronDown aria-hidden size={14} className="shrink-0 text-subtle-foreground" />
						)}
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="max-h-80 min-w-64 overflow-y-auto">
						{offered.length === 0 ? (
							<p className="m-0 px-2.5 py-2 text-muted-foreground text-xs">
								No models are switched on yet.
							</p>
						) : (
							<DropdownMenuRadioGroup
								value={model ?? ""}
								onValueChange={(value) => onChoose(value)}
							>
								{offered.map((candidate) => {
									const mark = modelLogoOf(candidate.modelId, candidate.providerPreset);
									return (
										<DropdownMenuRadioItem key={candidate.modelId} value={candidate.modelId}>
											{mark && <ProviderLogo preset={mark} className="size-3.5" />}
											<span className="min-w-0 flex-1 truncate">
												{candidate.displayName ?? candidate.modelId}
											</span>
											<span className="shrink-0 text-subtle-foreground text-xs">
												{candidate.providerName}
											</span>
										</DropdownMenuRadioItem>
									);
								})}
							</DropdownMenuRadioGroup>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
				{switchedOff && (
					<p className="m-0 text-warning text-xs">
						This model is no longer switched on for the workspace.
					</p>
				)}
			</div>
		</div>
	);
}

/** The tools that reach the web, which one switch turns on and off together: Web search. */
const WEB_TOOLS: readonly BuiltInToolKey[] = builtInToolCatalog
	.filter((entry) => entry.usesWeb)
	.map((entry) => entry.key);

/**
 * The services `bot` is connected to, each with how many of its tools it can
 * use. What each allows is set on the bot's Connections page, which Manage
 * beside the heading leads to. A connection whose tools are all off gives the
 * bot nothing, so it is left out.
 */
function BotConnections({ bot }: { bot: Bot }) {
	const connections = useConnections(bot.defaultProjectId);
	const reachable = connections.data?.filter((connection) => usableToolCount(connection) > 0);
	return (
		<SettingsGroup
			label="Connections"
			action={
				<SettingsGroupLink render={<Link {...botConnectionsLink(bot)} />}>Manage</SettingsGroupLink>
			}
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
						sub={countOf(tools, "tool", "tools")}
					/>
				);
			})}
		</SettingsGroup>
	);
}

/**
 * The tools `bot` has built in, rather than through its connections:
 * its computer, the web, and the rest of the catalog, each of which can be
 * switched off for it. The computer and the web are set up for the workspace
 * first; until they are, each says so and leads to where an admin sets it up.
 */
function BuiltInTools({
	bot,
	workspaceName,
	canChange,
	save,
}: {
	bot: Bot;
	workspaceName: string;
	canChange: boolean;
	save: Save;
}) {
	const backToBot = useBackToHere(bot.name);
	const webOff = useWebAccess().data?.enabled === false;
	const computersOff = useComputerAccess().data?.enabled === false;
	const isOn = (keys: readonly BuiltInToolKey[]) =>
		keys.some((key) => !bot.disabledTools.includes(key));
	const setTools = (keys: readonly BuiltInToolKey[], on: boolean) =>
		save({
			disabledTools: on
				? bot.disabledTools.filter((key) => !(keys as readonly string[]).includes(key))
				: [...new Set([...bot.disabledTools, ...keys])],
		}).catch(() => {});

	return (
		<SettingsGroup
			label="Built-in tools"
			action={
				bot.usesComputer &&
				!computersOff && (
					<SettingsGroupLink
						render={<Link {...botSettingsPageLink(bot, "computer")} state={backToBot} />}
					>
						Its computer
					</SettingsGroupLink>
				)
			}
		>
			<ToolRow
				label="Computer"
				sub={
					computersOff
						? `Computers are off for ${workspaceName}`
						: "Run commands, browse and edit files on a computer of its own"
				}
				on={bot.usesComputer && !computersOff}
				canChange={bot.permissions.resources.manageComputer}
				offReason={computersOff ? `Computers are off for ${workspaceName}` : undefined}
				onChange={(next) => save({ usesComputer: next }).catch(() => {})}
			/>
			{/* How it uses its computer's browser, so only while it has one. */}
			{bot.usesComputer && !computersOff && (
				<ToolRow
					label="Natural browsing"
					sub="Show a cursor, scroll smoothly and type at a typing pace, so people watching can follow along. Slower."
					on={bot.naturalBrowsing}
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

/**
 * Whether everyone in the workspace sees the bot, or only its creator: a
 * toggle for whoever may change the bot, else what it is.
 */
function VisibilityRow({
	bot,
	editable,
	savePending,
	save,
}: {
	bot: Bot;
	editable: boolean;
	savePending: boolean;
	save: Save;
}) {
	const isPublic = bot.visibility === "public";
	const viewerId = useSession().user?.id;
	const mine = bot.createdBy !== null && bot.createdBy.id === viewerId;
	return (
		<SettingsRow
			label="Public"
			sub={
				isPublic
					? "Everyone in the workspace can see it, talk to it and add it to projects. Making it private takes it out of its projects"
					: mine
						? "Only you can see it and talk to it"
						: "Only the person who made it can see it and talk to it"
			}
			trailing={
				editable ? (
					<Toggle
						checked={isPublic}
						disabled={savePending}
						label={isPublic ? "Make private" : "Make public"}
						onChange={(on) => {
							void save({ visibility: on ? "public" : "private" }).catch(() => {});
						}}
					/>
				) : (
					<SettingsValue>{isPublic ? "Public" : "Private"}</SettingsValue>
				)
			}
		/>
	);
}

/** A link beside a group's label, to the page its rows are changed on, such as Manage ↗. */
function SettingsGroupLink({
	render,
	children,
}: {
	/** The link it is: `render={<Link … />}`. */
	render: useRender.RenderProp;
	children: ReactNode;
}) {
	return useRender({
		render,
		props: {
			className:
				"focus-ring flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground",
			children: (
				<>
					{children}
					<ArrowUpRight aria-hidden size={13} strokeWidth={2} />
				</>
			),
		},
	});
}
