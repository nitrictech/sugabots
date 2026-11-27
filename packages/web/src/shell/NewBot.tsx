import { botPalettes, CREATION_MOODS, type LivelyFace, useMoodLoop } from "@sugabots/avatars";
import {
	BOT_NAME_MAX_LENGTH,
	type Bot,
	type BotColor,
	type BotEyes,
	type BotShape,
	type BotVisibility,
	type BuiltInProviderId,
	botColors,
	botEyes,
	botShapes,
	type ProviderModelCapability,
} from "@sugabots/contracts";
import { ProviderLogo } from "@sugabots/provider-logos";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { AudioLines, Brain, Eye, Image, Pencil, SmilePlus, Star, Wrench } from "lucide-react";
import {
	type CSSProperties,
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { useBots, useCreateBot, useModels } from "@/lib/bots.ts";
import { useStartInterview } from "@/lib/chats.ts";
import { failureMessage } from "@/lib/failure.ts";
import { botLink, chatLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { formatCount } from "@/lib/name-list.ts";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { BotColourPicker, EyesGlyph, ShapeGlyph } from "@/shell/AvatarPicker.tsx";
import { BotAvatar } from "@/shell/Bot.tsx";
import { Alert } from "@/ui/alert.tsx";
import { BackButton, BackChevron } from "@/ui/back-button.tsx";
import { Button } from "@/ui/button.tsx";
import { CloseButton } from "@/ui/close-button.tsx";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/ui/dialog.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { LetterTile } from "@/ui/letter-tile.tsx";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group.tsx";
import { SearchField, useSearchFilter } from "@/ui/search-field.tsx";
import { SettingsRadioMark } from "@/ui/settings-page.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs.tsx";

/** A bot's avatar: its colour, shape and eyes. */
export interface Avatar {
	color: BotColor;
	shape: BotShape;
	eyes: BotEyes;
}

/** How many avatars are offered, with Customise after them, two rows of four. */
const AVATARS_OFFERED = 7;

/** How many models Suggested holds: the default, then those most bots use. */
const SUGGESTED_MODELS = 3;

/** A model the bot can think with, as the workspace lists those switched on. */
interface OfferedModel {
	modelId: string;
	displayName: string | null;
	providerName: string;
	providerBuiltIn: BuiltInProviderId | null;
	capabilities: readonly ProviderModelCapability[];
}

/** Which part of an avatar is being chosen. */
export type Part = "shape" | "eyes";

/**
 * Making a bot. At the left the bot as it will be, on a tint of its colour,
 * its name written over it, and a few avatars drawn at random, with Customise
 * for its colour, head and eyes, which open at the right in place of the
 * models. At the right the models it can think with, the suggested first,
 * then each provider's. It is public unless made private or personal, and
 * starts by asking its creator what it's for in its first chat.
 */
export function NewBotDialog({ onCreated }: { onCreated: (bot: Bot) => Promise<void> }) {
	const [name, setName] = useState("");
	const [avatars, setAvatars] = useState(randomAvatars);
	const [chosenAvatar, setChosenAvatar] = useState(0);
	const [customising, setCustomising] = useState(false);
	const [part, setPart] = useState<Part>("shape");
	const [chosenModel, setChosenModel] = useState<string>();
	const create = useCreateBot();
	const [visibility, setVisibility] = useState<BotVisibility>("public");
	const models = useModels();
	const offered: readonly OfferedModel[] = models.data?.models ?? [];
	// The default goes unoffered while a failed test has its provider off.
	const model =
		chosenModel ??
		offered.find((candidate) => candidate.modelId === models.data?.defaultModel)?.modelId ??
		offered[0]?.modelId;
	const trimmedName = name.trim();
	const avatar = avatars[chosenAvatar] ??
		avatars[0] ?? { color: "violet", shape: "circle", eyes: "pill" };

	function change(changes: Partial<Avatar>) {
		setAvatars(
			avatars.map((one, index) => (index === chosenAvatar ? { ...one, ...changes } : one)),
		);
	}

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!trimmedName || !model) return;
		try {
			// Made without instructions, a bot starts by interviewing its creator.
			const bot = await create.mutateAsync({ name: trimmedName, model, visibility, ...avatar });
			await onCreated(bot);
		} catch {
			return;
		}
	}

	// A tint of the bot's colour, so the bot is shown in its own light.
	const stage = {
		background: `color-mix(in oklab, ${botPalettes[avatar.color].face} 9%, var(--list))`,
	};
	const canCreate = Boolean(trimmedName && model) && !create.isPending;
	// A phone has Create at the top, as its pages have their main action; one Create either way.
	const phone = !useMediaQuery(SIDE_BY_SIDE);
	const failures = (
		<>
			{create.error && (
				<Alert>
					{failureMessage(create.error, {
						Conflict: "A bot with that name already exists. Try another name.",
						Forbidden: "You can't make a bot in this workspace.",
					})}
				</Alert>
			)}
			{models.error && <Alert>Models could not be loaded. Close this and try again.</Alert>}
		</>
	);

	return (
		<DialogContent
			showCloseButton={false}
			// On a phone, a page of its own, as tall as what the keyboard leaves.
			className="max-h-dialog gap-0 overflow-hidden p-0 sm:max-w-3xl max-md:inset-0 max-md:flex max-md:h-visible max-md:max-h-none max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:flex-col max-md:rounded-none"
		>
			<DialogTitle className="sr-only">New bot</DialogTitle>
			<form
				onSubmit={submit}
				className="flex min-h-0 min-w-0 flex-col max-md:flex-1 max-md:overflow-y-auto md:h-bot-editor md:flex-row"
			>
				{phone ? (
					<PhoneNewBot
						stage={stage}
						name={name}
						onNameChange={setName}
						avatar={avatar}
						customising={customising}
						onCustomise={setCustomising}
						avatarStep={
							<AvatarStep part={part} avatar={avatar} onPartChange={setPart} onChange={change} />
						}
						canCreate={canCreate}
						alerts={
							<>
								<VisibilityChoice value={visibility} onChange={setVisibility} />
								{failures}
							</>
						}
						modelPicker={
							<ModelPicker
								models={offered}
								value={model}
								defaultModel={models.data?.defaultModel}
								loading={models.isPending}
								onChoose={setChosenModel}
							/>
						}
					/>
				) : (
					<>
						<div
							className="flex w-72 shrink-0 flex-col items-center gap-5 p-6 transition-colors"
							style={stage}
						>
							<input
								aria-label="Name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder="Name your bot"
								maxLength={BOT_NAME_MAX_LENGTH}
								autoComplete="off"
								// biome-ignore lint/a11y/noAutofocus: naming the bot is the one thing the dialog cannot guess.
								autoFocus
								className="mt-4 w-full rounded-xl border border-transparent bg-transparent px-3 py-2 text-center font-semibold text-xl text-foreground focus-ring transition-colors placeholder:text-subtle-foreground hover:border-border-strong hover:bg-chip focus-visible:border-border-strong focus-visible:bg-chip"
							/>
							<div className="grid flex-1 place-items-center">
								<CreationFace avatar={avatar} />
							</div>
							<LookGrid
								avatars={avatars}
								chosen={chosenAvatar}
								onChoose={(index) => {
									setChosenAvatar(index);
									setCustomising(false);
								}}
								customising={customising}
								onCustomise={() => setCustomising(!customising)}
							/>
							<VisibilityChoice value={visibility} onChange={setVisibility} />
							{failures}
							<Button type="submit" className="w-full" disabled={!canCreate}>
								Create
							</Button>
						</div>

						<div className="flex min-h-0 min-w-0 flex-1 flex-col border-border border-l bg-panel">
							{customising ? (
								<AvatarStep
									part={part}
									avatar={avatar}
									onPartChange={setPart}
									onChange={change}
									onDone={() => setCustomising(false)}
								/>
							) : (
								<ModelPicker
									models={offered}
									value={model}
									defaultModel={models.data?.defaultModel}
									loading={models.isPending}
									onChoose={setChosenModel}
								/>
							)}
						</div>
					</>
				)}
			</form>
		</DialogContent>
	);
}

/**
 * Making a bot on a phone, as two pages in one: the bot, its name and its
 * model, with Close and Create at the top; and, from the bot's face, its avatar,
 * with Back. The face rises and shrinks while the name is typed, so the name
 * and the models stay in view above the keyboard.
 */
function PhoneNewBot({
	stage,
	name,
	onNameChange,
	avatar,
	customising,
	onCustomise,
	avatarStep,
	canCreate,
	alerts,
	modelPicker,
}: {
	/** The bot's colour as a tint, behind its face. */
	stage: CSSProperties;
	name: string;
	onNameChange: (name: string) => void;
	avatar: Avatar;
	/** Whether the avatar's page is open. */
	customising: boolean;
	onCustomise: (customising: boolean) => void;
	/** The avatar's page: its shape, eyes and colour. */
	avatarStep: ReactNode;
	canCreate: boolean;
	alerts: ReactNode;
	modelPicker: ReactNode;
}) {
	const [naming, setNaming] = useState(false);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header
				className="sticky top-0 z-10 grid grid-cols-centered items-center gap-3 px-4 pt-safe-or-3 pb-2 transition-colors"
				style={stage}
			>
				<span className="flex justify-self-start">
					{customising ? (
						<BackButton onClick={() => onCustomise(false)} />
					) : (
						<CloseButton render={<DialogClose />} />
					)}
				</span>
				<span className="font-semibold text-base text-foreground">
					{customising ? "Avatar" : "New bot"}
				</span>
				<span className="flex justify-self-end">
					{!customising && (
						<Button
							type="submit"
							size="sm"
							className="h-11 rounded-full px-5 text-sm"
							disabled={!canCreate}
						>
							Create
						</Button>
					)}
				</span>
			</header>
			<div
				className="flex shrink-0 flex-col items-center gap-4 px-4 pt-2 pb-5 transition-colors"
				style={stage}
			>
				<button
					type="button"
					aria-label={customising ? undefined : "Change the avatar"}
					disabled={customising}
					onClick={() => onCustomise(true)}
					className={cn(
						"focus-ring relative flex justify-center rounded-3xl transition-all duration-300 ease-out motion-reduce:transition-none",
						naming || customising ? "h-14" : "h-28",
					)}
				>
					<span
						className={cn(
							"origin-top transition-transform duration-300 ease-out motion-reduce:transition-none",
							(naming || customising) && "scale-50",
						)}
					>
						<CreationFace avatar={avatar} />
					</span>
					{!customising && !naming && (
						<span
							aria-hidden
							className="glass absolute -right-1 -bottom-1 grid size-8 place-items-center rounded-full text-foreground"
						>
							<Pencil size={14} strokeWidth={2} />
						</span>
					)}
				</button>
				{!customising && (
					<>
						<input
							aria-label="Name"
							value={name}
							onChange={(event) => onNameChange(event.target.value)}
							onFocus={() => setNaming(true)}
							onBlur={() => setNaming(false)}
							placeholder="Name your bot"
							maxLength={BOT_NAME_MAX_LENGTH}
							autoComplete="off"
							className="h-12 w-full rounded-xl border border-border-strong bg-panel px-4 text-base text-foreground outline-none placeholder:text-subtle-foreground focus:border-primary-tint-border"
						/>
						{alerts}
					</>
				)}
			</div>
			<div className="flex min-h-0 flex-1 flex-col border-border border-t bg-panel">
				{customising ? avatarStep : modelPicker}
			</div>
		</div>
	);
}

/**
 * The avatars to start from, two rows of four with Customise last, which opens
 * the chosen one's colour, head and eyes beside them. The chosen one is
 * ringed. Each is a native radio, so arrow keys move the choice.
 */
function LookGrid({
	avatars,
	chosen,
	onChoose,
	customising,
	onCustomise,
}: {
	avatars: readonly Avatar[];
	chosen: number;
	onChoose: (index: number) => void;
	customising: boolean;
	onCustomise: () => void;
}) {
	const group = useId();
	return (
		<fieldset className="m-0 grid grid-cols-4 gap-2 border-0 p-0">
			<legend className="sr-only">Avatars</legend>
			{avatars.map((avatar, index) => (
				<Tile
					// biome-ignore lint/suspicious/noArrayIndexKey: a avatar is changed in its place, so its place is its key.
					key={index}
					group={group}
					label={`${avatar.color} ${avatar.shape}`}
					chosen={index === chosen}
					onChoose={() => onChoose(index)}
					size="sm"
				>
					<BotAvatar color={avatar.color} eyes={avatar.eyes} shape={avatar.shape} size={32} />
				</Tile>
			))}
			<button
				type="button"
				onClick={onCustomise}
				aria-label="Colour, shape and eyes"
				aria-pressed={customising}
				className="focus-ring grid size-14 place-items-center rounded-full bg-chip text-soft-foreground transition-colors hover:bg-hover hover:text-foreground aria-pressed:bg-chip-strong aria-pressed:text-foreground"
			>
				<SmilePlus aria-hidden size={20} strokeWidth={1.75} />
			</button>
		</fieldset>
	);
}

/**
 * The models switched on for the workspace, to search: Suggested first, the
 * default and those most bots think with, then each provider's under its logo.
 * Each shows what it can do, and a radio for the one chosen. Arrow keys move from the search into the list and along it.
 */
function ModelPicker({
	models,
	value,
	defaultModel,
	loading,
	onChoose,
}: {
	models: readonly OfferedModel[];
	value: string | undefined;
	defaultModel: string | null | undefined;
	loading: boolean;
	onChoose: (modelId: string) => void;
}) {
	const {
		query: search,
		setQuery: setSearch,
		searching,
		matches: found,
	} = useSearchFilter(models, (model) => [model.displayName, model.modelId, model.providerName]);
	const { bots } = useBots();
	const list = useRef<HTMLDivElement>(null);
	const countUsers = (modelId: string) => bots?.filter((bot) => bot.model === modelId).length ?? 0;
	const suggested = searching
		? []
		: [...models]
				.sort(
					(a, b) =>
						Number(b.modelId === defaultModel) - Number(a.modelId === defaultModel) ||
						countUsers(b.modelId) - countUsers(a.modelId),
				)
				.filter((model, index) => index === 0 || countUsers(model.modelId) > 0)
				.slice(0, SUGGESTED_MODELS);
	const rest = found.filter((model) => !suggested.includes(model));
	const providers = [...new Set(rest.map((model) => model.providerName))];

	function moveFocus(event: KeyboardEvent, from: HTMLElement | null) {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const rows = [...(list.current?.querySelectorAll<HTMLElement>("[data-model-row]") ?? [])];
		if (rows.length === 0) return;
		event.preventDefault();
		const at = from ? rows.indexOf(from) : -1;
		const next = event.key === "ArrowDown" ? at + 1 : at - 1;
		rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
	}

	const row = (model: OfferedModel) => (
		<ModelRow
			key={model.modelId}
			model={model}
			chosen={model.modelId === value}
			isDefault={model.modelId === defaultModel}
			onChoose={() => onChoose(model.modelId)}
			onKeyDown={moveFocus}
		/>
	);

	return (
		<section aria-label="Model" className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 flex-col gap-4 px-5 pt-5 pb-3">
				<div className={HEADER_ROW}>
					<h2 className="m-0 flex-1 font-semibold text-sm text-foreground">Model</h2>
					<Close />
				</div>
				<SearchField
					label="Search models"
					value={search}
					onChange={setSearch}
					onKeyDown={(event) => {
						if (event.key === "Enter" && found[0]) {
							event.preventDefault();
							onChoose(found[0].modelId);
							return;
						}
						moveFocus(event, null);
					}}
					placeholder={`Search ${formatCount(models.length, "model", "models")}`}
					autoComplete="off"
					className="h-10 gap-2 rounded-lg border border-border-strong bg-transparent"
				/>
			</div>
			<div ref={list} className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 max-md:max-h-96">
				{found.length === 0 && (
					<p className="m-0 px-2 py-3 text-xs text-muted-foreground">
						{loading
							? "Loading models…"
							: models.length === 0
								? "No models are switched on yet. Connect one in Settings under Models."
								: "No models match."}
					</p>
				)}
				{suggested.length > 0 && (
					<ModelGroup label="Suggested" mark={<Star aria-hidden size={14} strokeWidth={1.75} />}>
						{suggested.map(row)}
					</ModelGroup>
				)}
				{providers.map((provider) => {
					const inGroup = rest.filter((model) => model.providerName === provider);
					return (
						<ModelGroup
							key={provider}
							label={provider}
							mark={inGroup[0] && <ProviderMark model={inGroup[0]} />}
						>
							{inGroup.map(row)}
						</ModelGroup>
					);
				})}
			</div>
		</section>
	);
}

function ModelGroup({
	label,
	mark,
	children,
}: {
	label: string;
	mark: ReactNode;
	children: ReactNode;
}) {
	return (
		<section aria-label={label} className="flex flex-col pb-2">
			<h3 className="m-0 flex items-center gap-2 px-2 pt-2 pb-1.5 font-medium text-xs text-muted-foreground">
				{mark}
				{label}
			</h3>
			{children}
		</section>
	);
}

/** What a model can do, as the icons on its row draw it, with the words a screen reader hears. */
const CAPABILITY_ICONS: Partial<
	Record<ProviderModelCapability, { icon: typeof Wrench; label: string }>
> = {
	tools: { icon: Wrench, label: "uses tools" },
	vision: { icon: Eye, label: "reads images" },
	thinking: { icon: Brain, label: "thinks" },
	images: { icon: Image, label: "makes images" },
	audio: { icon: AudioLines, label: "hears and speaks" },
};

/**
 * A model to choose: its name, Default on the workspace's default, under it
 * what it can do, and a radio at its end.
 */
function ModelRow({
	model,
	chosen,
	isDefault,
	onChoose,
	onKeyDown,
}: {
	model: OfferedModel;
	chosen: boolean;
	isDefault: boolean;
	onChoose: () => void;
	onKeyDown: (event: KeyboardEvent, from: HTMLElement) => void;
}) {
	const shown = model.capabilities.flatMap((capability) => {
		const drawn = CAPABILITY_ICONS[capability];
		return drawn ? [{ capability, ...drawn }] : [];
	});
	return (
		<button
			type="button"
			data-model-row
			aria-pressed={chosen}
			onClick={onChoose}
			onKeyDown={(event) => onKeyDown(event, event.currentTarget)}
			className={cn(
				"focus-ring flex min-h-14 items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-chip",
				chosen && "bg-chip",
			)}
		>
			<span className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="flex min-w-0 items-center gap-2">
					<span className="truncate font-medium text-sm text-foreground">{nameOfModel(model)}</span>
					{isDefault && (
						<span className="shrink-0 rounded border border-border-strong px-1.5 font-medium text-2xs text-muted-foreground leading-4">
							Default
						</span>
					)}
				</span>
				{shown.length > 0 && (
					<span className="flex items-center gap-1.5 text-subtle-foreground">
						{shown.map(({ capability, icon: Icon, label }) => (
							<span key={capability} title={label} className="flex">
								<Icon aria-hidden size={13} strokeWidth={1.75} />
								<span className="sr-only">{label}</span>
							</span>
						))}
					</span>
				)}
			</span>
			<SettingsRadioMark checked={chosen} />
		</button>
	);
}

/** The bot being made, large: hopping each time its avatar changes, and moving through `CREATION_MOODS`. */
function CreationFace({ avatar }: { avatar: Avatar }) {
	const mood = useMoodLoop(CREATION_MOODS);
	const eyes = useRef<LivelyFace>(null);
	const key = avatarKey(avatar);
	const shownKey = useRef(key);
	useEffect(() => {
		if (key === shownKey.current) return;
		shownKey.current = key;
		eyes.current?.hop();
	}, [key]);
	return (
		<BotAvatar
			color={avatar.color}
			eyes={avatar.eyes}
			shape={avatar.shape}
			size={112}
			lively={{ mood, watchPointer: true, ref: eyes }}
		/>
	);
}

/** Names a avatar, so the bot hops whenever any part of it changes. */
function avatarKey({ color, shape, eyes }: Avatar): string {
	return `${color}-${shape}-${eyes}`;
}

/** Avatars to start from, with no colour twice before every colour has been used. */
function randomAvatars(): Avatar[] {
	const colors = [...shuffled(botColors), ...shuffled(botColors)].slice(0, AVATARS_OFFERED);
	return colors.map((color) => ({ color, shape: pick(botShapes), eyes: pick(botEyes) }));
}

function pick<Item>(items: readonly Item[]): Item {
	return items[Math.floor(Math.random() * items.length)] as Item;
}

function shuffled<Item>(items: readonly Item[]): Item[] {
	const copy = [...items];
	for (let index = copy.length - 1; index > 0; index--) {
		const other = Math.floor(Math.random() * (index + 1));
		[copy[index], copy[other]] = [copy[other] as Item, copy[index] as Item];
	}
	return copy;
}

function nameOfModel(model: OfferedModel | undefined): string | undefined {
	return model && (model.displayName ?? model.modelId);
}

/** A square to choose one avatar or part from, a native radio, ringed while it is chosen. */
function Tile({
	group,
	label,
	chosen,
	onChoose,
	size = "md",
	children,
}: {
	group: string;
	label: string;
	chosen: boolean;
	onChoose: () => void;
	size?: "sm" | "md";
	children: ReactNode;
}) {
	return (
		<label
			className={cn(
				size === "sm" ? "size-14" : "size-16",
				"grid shrink-0 cursor-pointer place-items-center rounded-xl transition-colors has-focus-visible:shadow-(--ring-shadow)",
				// One inset ring rather than a border round a fill, whose two rounded edges leave a seam.
				chosen ? "bg-chip inset-ring-2 inset-ring-subtle-foreground" : "hover:bg-chip",
			)}
		>
			<input
				type="radio"
				name={group}
				aria-label={label}
				checked={chosen}
				onChange={onChoose}
				className="sr-only"
			/>
			{children}
		</label>
	);
}

/** The height of a right-hand page's title row, the same for the models and a avatar's parts. */
const HEADER_ROW = "flex h-6 shrink-0 items-center";

/** A step past the start: Back, and its title or tabs beside it. */
function StepHeader({ onBack, children }: { onBack?: () => void; children: ReactNode }) {
	return (
		// The same row as the models' title, so a step's tabs sit level with "Model".
		<div className="shrink-0 px-5 pt-5 pb-4">
			<div className={cn(HEADER_ROW, "gap-2")}>
				{onBack && (
					<IconButton label="Back" onClick={onBack} className="-ml-1">
						<BackChevron />
					</IconButton>
				)}
				{children}
				<span className="flex-1" />
				<Close />
			</div>
		</div>
	);
}

/** The dialog's ×, in a page's title row, so it is level with the title; a phone has its own at the top. */
function Close() {
	return <CloseButton render={<DialogClose />} className="-mr-1.5 max-md:hidden" />;
}

/**
 * Every head shape, drawn bare in the avatar's colour, or every pair of eyes,
 * drawn alone, with the colours along the foot. Given `onDone`, Back returns
 * to where it was opened from; a bot's own editor shows it with nothing to
 * go back to.
 */
export function AvatarStep({
	part,
	avatar,
	onPartChange,
	onChange,
	onDone,
}: {
	part: Part;
	avatar: Avatar;
	onPartChange: (part: Part) => void;
	onChange: (changes: Partial<Avatar>) => void;
	/** Back from it to the models, in its own header; absent on a phone, whose Back is at the top of the page. */
	onDone?: () => void;
}) {
	const group = useId();
	return (
		<Tabs
			value={part}
			onValueChange={(chosen) => onPartChange(chosen === "eyes" ? "eyes" : "shape")}
			className="min-h-0 flex-1"
		>
			<StepHeader onBack={onDone}>
				<TabsList aria-label="Part">
					<TabsTrigger value="shape">Shape</TabsTrigger>
					<TabsTrigger value="eyes">Eyes</TabsTrigger>
				</TabsList>
			</StepHeader>
			<TabsContent value="shape" className="flex min-h-0 min-w-0 flex-1 flex-col">
				<TileGrid legend="Shape">
					{botShapes.map((one) => (
						<Tile
							key={one}
							group={`${group}-shape`}
							label={one}
							chosen={one === avatar.shape}
							onChoose={() => onChange({ shape: one })}
						>
							<span className="flex" style={{ color: botPalettes[avatar.color].face }}>
								<ShapeGlyph shape={one} size={44} />
							</span>
						</Tile>
					))}
				</TileGrid>
			</TabsContent>
			<TabsContent value="eyes" className="flex min-h-0 min-w-0 flex-1 flex-col">
				<TileGrid legend="Eyes">
					{botEyes.map((one) => (
						<Tile
							key={one}
							group={`${group}-eyes`}
							label={one}
							chosen={one === avatar.eyes}
							onChoose={() => onChange({ eyes: one })}
						>
							<span className="flex text-foreground">
								<EyesGlyph eyes={one} width={44} />
							</span>
						</Tile>
					))}
				</TileGrid>
			</TabsContent>
			<div className="shrink-0 px-5 pb-5">
				<div className="rounded-2xl border border-border-strong px-4 py-3.5">
					<BotColourPicker value={avatar.color} onChange={(color) => onChange({ color })} />
				</div>
			</div>
		</Tabs>
	);
}

/** The tiles of one part of an avatar, four to a row, scrolling when they don't fit. */
function TileGrid({ legend, children }: { legend: string; children: ReactNode }) {
	return (
		<fieldset className="m-0 grid min-h-0 min-w-0 flex-1 auto-rows-min grid-cols-4 justify-items-center gap-2 overflow-y-auto border-0 px-5 pb-4">
			<legend className="sr-only">{legend}</legend>
			{children}
		</fieldset>
	);
}

/** A model's provider, as its logo, or its initial when it has none. */
function ProviderMark({ model }: { model: OfferedModel }) {
	return model.providerBuiltIn ? (
		<ProviderLogo builtIn={model.providerBuiltIn} className="size-3.5 shrink-0" />
	) : (
		<LetterTile
			name={model.providerName}
			className="size-3.5 rounded border-0 bg-chip-strong font-normal text-3xs text-current"
		/>
	);
}

/** What each choice of who sees a new bot means, in a line under the choice. */
const VISIBILITY_OPTIONS: readonly { value: BotVisibility; label: string }[] = [
	{ value: "public", label: "Public" },
	{ value: "private", label: "Private" },
	{ value: "personal", label: "Personal" },
];

const VISIBILITY_MEANINGS: Record<BotVisibility, string> = {
	public: "Everyone in the workspace can see it and talk to it.",
	private: "Only you, admins and the members you invite can see it.",
	personal: "Only you can see it, and it acts with your access. This can't be changed later.",
};

/**
 * Whether the new bot is public, for everyone in the workspace; private, for
 * the members invited to it; or personal, for its creator alone.
 */
function VisibilityChoice({
	value,
	onChange,
}: {
	value: BotVisibility;
	onChange: (value: BotVisibility) => void;
}) {
	const meaning = useId();
	return (
		<div className="flex w-full flex-col gap-1.5">
			<RadioGroup
				aria-label="Who can see it"
				aria-describedby={meaning}
				value={value}
				onValueChange={onChange}
				className="w-full"
			>
				{VISIBILITY_OPTIONS.map((option) => (
					<RadioGroupItem key={option.value} value={option.value} className="flex-1">
						{option.label}
					</RadioGroupItem>
				))}
			</RadioGroup>
			<p id={meaning} className="text-muted-foreground text-xs">
				{VISIBILITY_MEANINGS[value]}
			</p>
		</div>
	);
}

/**
 * What starts a bot, absent where the viewer may not make one, and the dialog
 * that makes it, which must be rendered for it to open. It opens the bot once
 * it is made, on the chat in which it interviews its maker when it has one.
 */
export function useNewBot(): { start?: () => void; dialog: ReactNode } {
	const [creating, setCreating] = useState(false);
	const navigate = useNavigate();
	const may = useWorkspacePermissions();
	const interview = useStartInterview();
	return {
		start: may.createBots ? () => setCreating(true) : undefined,
		dialog: (
			<Dialog open={creating} onOpenChange={setCreating}>
				<NewBotDialog
					onCreated={async (bot) => {
						setCreating(false);
						const chat = await interview.mutateAsync(bot.id).catch(() => null);
						if (chat) await navigate(chatLink({ bot, chatId: chat.id }));
						else await navigate(botLink(bot));
					}}
				/>
			</Dialog>
		),
	};
}
