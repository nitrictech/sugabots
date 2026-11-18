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
import { Link, linkOptions, useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowUpRight, Pencil, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { useDeleteBot, useModelName, useUpdateBot } from "@/lib/bots.ts";
import { useComputerAccess } from "@/lib/computer-providers.ts";
import { usableToolCount, useConnections } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { botSettingsPageLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { useWebAccess } from "@/lib/search-provider.ts";
import { useSession } from "@/lib/session.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspace, useWorkspaceMembers } from "@/lib/workspace.ts";
import { BotAvatar } from "@/shell/Bot.tsx";
import { type Look, LookStep, type Part } from "@/shell/NewBot.tsx";
import { Alert } from "@/ui/alert.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";
import { BACK_BUTTON, useLeave } from "@/ui/back-button.tsx";
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
import { BotAutomations } from "./AutomationEditing.tsx";
import { BotModelPicker } from "./BotModelPicker.tsx";

/*
 * One bot, as its contact card: its face and colour first, then what it is,
 * what it thinks with and what it is told, what it can reach, and what it does
 * unprompted. Model and instructions each open on a page of their own in the
 * same place, so the card never rearranges under you.
 *
 * What can be changed comes from the bot's resolved permissions, and a control
 * nobody may use is not drawn. Each field saves on its own; instructions are
 * prose somebody may be part-way through, so they wait for Save.
 */
export function BotSettingsPage({ bot }: { bot: Bot }) {
	const [page, setPage] = useState<"card" | "model" | "instructions">("card");
	const update = useUpdateBot(bot.id);
	const failure = update.error ? failureMessage(update.error) : undefined;
	const back = (
		<PageBackLink
			label={bot.name}
			render={<button type="button" onClick={() => setPage("card")} />}
		/>
	);

	if (page === "model" && !bot.assistant) {
		return (
			<SettingsPage
				back={back}
				backOnWide
				title="Model"
				description={`What ${bot.name} thinks with.`}
			>
				{failure && <Alert>{failure}</Alert>}
				<BotModelPicker
					botName={bot.name}
					model={bot.model}
					canChoose={bot.permissions.update && !bot.assistant}
					onChoose={(model) => {
						void update.mutateAsync({ model }).catch(() => {});
					}}
				/>
			</SettingsPage>
		);
	}
	if (page === "instructions" && !bot.assistant) {
		return (
			<Instructions
				bot={bot}
				editable={bot.permissions.update && !bot.assistant}
				back={back}
				save={update.mutateAsync}
				savePending={update.isPending}
				failure={failure}
			/>
		);
	}
	return (
		<ContactCard
			bot={bot}
			save={update.mutateAsync}
			savePending={update.isPending}
			failure={failure}
			onOpenModel={() => setPage("model")}
			onOpenInstructions={() => setPage("instructions")}
		/>
	);
}

type Save = (change: BotUpdate) => Promise<unknown>;

function ContactCard({
	bot,
	save,
	savePending,
	failure,
	onOpenModel,
	onOpenInstructions,
}: {
	bot: Bot;
	save: Save;
	savePending: boolean;
	failure: string | undefined;
	onOpenModel: () => void;
	onOpenInstructions: () => void;
}) {
	const may = bot.permissions;
	// A Personal Assistant's prompt, model and tools are ours: its person changes its look (name, colour, face, shape) and connections.
	const fixed = bot.assistant;
	const modelName = useModelName(bot.model);
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
			{failure && <Alert>{failure}</Alert>}
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
							wide
							editable={may.update}
							savePending={savePending}
							onCommit={(description) => save({ description })}
						/>
						<VisibilityRow bot={bot} editable={may.update} savePending={savePending} save={save} />
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
						<AddedByRow bot={bot} />
					</>
				)}
			</SettingsGroup>
			{!fixed && (
				<BuiltInTools bot={bot} workspaceName={workspaceName} canChange={may.update} save={save} />
			)}
			<BotConnections bot={bot} />
			{!fixed && <BotAutomations bot={bot} />}
			{may.delete && !fixed && (
				<SettingsDanger
					label="Delete bot"
					description="Its tasks, automations and settings go with it."
					action="Delete"
					onClick={() => setConfirmingDelete(true)}
				/>
			)}
			<DeleteDialog
				open={confirmingDelete}
				onOpenChange={setConfirmingDelete}
				title={`Delete ${bot.name}?`}
				description="Its tasks, automations and settings go with it. This can't be undone."
				pending={remove.isPending}
				error={remove.error ? failureMessage(remove.error) : undefined}
				onDelete={deleteBot}
			/>
		</SettingsPage>
	);
}

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
							<button type="button" aria-label="Cancel" onClick={done} className={BACK_BUTTON}>
								<X aria-hidden size={20} strokeWidth={2.25} />
							</button>
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
 * Who added the bot, with their face, and when. Somebody since gone from the
 * workspace is named as such rather than left blank; a bot nobody added was
 * made with the workspace.
 */
function AddedByRow({ bot }: { bot: Bot }) {
	const { data: members } = useWorkspaceMembers(bot.workspaceId);
	const adder = members?.find((member) => member.user.id === bot.createdById)?.user;
	const when = new Date(bot.createdAt).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
	// Said once the roster has answered, rather than guessed before it.
	const who =
		bot.createdById === null
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
				className={cn("text-sm text-foreground", wide ? "w-24 shrink-0" : "flex-1")}
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
						"h-8 min-w-0 rounded-md border border-border-strong bg-settings-row-hover px-2.5 text-xs text-foreground outline-none placeholder:text-subtle-foreground focus-visible:border-ring",
						wide ? "flex-1" : "w-60 max-w-1/2",
					)}
				/>
			) : (
				<span id={id} className={cn("min-w-0 text-xs text-muted-foreground", wide && "flex-1")}>
					{value || "None yet"}
				</span>
			)}
		</div>
	);
}

const countFormat = new Intl.NumberFormat("en");

function Instructions({
	bot,
	editable,
	back,
	save,
	savePending,
	failure,
}: {
	bot: Bot;
	editable: boolean;
	back: React.ReactNode;
	save: Save;
	savePending: boolean;
	failure: string | undefined;
}) {
	const [draft, setDraft] = useState(bot.prompt);
	const id = useId();
	const dirty = draft !== bot.prompt;

	return (
		<SettingsPage
			back={back}
			backOnWide
			title="Instructions"
			description={`How ${bot.name} should work. It follows these in every chat.`}
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
					className="block min-h-95 w-full resize-y rounded-xl bg-transparent p-3.5 text-xs text-foreground leading-relaxed outline-none placeholder:text-subtle-foreground focus-visible:shadow-(--ring-shadow)"
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
 * The services `bot` is connected to, each with how many of its tools it can
 * use. What each allows is set on the bot's Connections page, which Manage
 * beside the heading leads to. A connection whose tools are all off gives the
 * bot nothing, so it is left out.
 */
function BotConnections({ bot }: { bot: Bot }) {
	const backToBot = useBackToHere(bot.name);
	const connections = useConnections(bot.id);
	const reachable = connections.data?.filter((connection) => usableToolCount(connection) > 0);
	return (
		<SettingsGroup
			label="Connections"
			action={
				<Link
					{...botSettingsPageLink(bot, "connections")}
					state={backToBot}
					className="focus-ring flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					Manage
					<ArrowUpRight aria-hidden size={13} strokeWidth={2} />
				</Link>
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
						sub={`${tools} ${tools === 1 ? "tool" : "tools"}`}
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
					<Link
						{...botSettingsPageLink(bot, "computer")}
						state={backToBot}
						className="focus-ring flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						Its computer
						<ArrowUpRight aria-hidden size={13} strokeWidth={2} />
					</Link>
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
				canChange={bot.permissions.manageComputer}
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
	const mine = bot.createdById === useSession().user?.id;
	return (
		<SettingsRow
			label="Public"
			sub={
				isPublic
					? "Everyone in the workspace can see it, talk to it and add it to channels. Making it private takes it out of its channels"
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
