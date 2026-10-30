import { botColors } from "@sugabots/avatars";
import {
	type Agent,
	type AgentColor,
	type AgentFace,
	type AgentShape,
	agentColors,
	agentFaces,
	agentShapes,
	type ProviderModelCapability,
	type ProviderPresetId,
} from "@sugabots/contracts";
import { ProviderLogo } from "@sugabots/provider-logos";
import { cn } from "cn";
import {
	ArrowLeft,
	AudioLines,
	Brain,
	Eye,
	Image,
	Pencil,
	Search,
	SmilePlus,
	Star,
	Wrench,
	X,
} from "lucide-react";
import {
	type CSSProperties,
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	useId,
	useRef,
	useState,
} from "react";
import { useAgents, useCreateAgent, useModels } from "@/lib/agents.ts";
import { failureMessage } from "@/lib/failure.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { countOf } from "@/lib/name-list.ts";
import { AgentAvatar } from "@/shell/Agent.tsx";
import { EyesGlyph, ShapeGlyph } from "@/shell/LookPicker.tsx";
import { Alert } from "@/ui/alert.tsx";
import { BACK_BUTTON, BackChevron } from "@/ui/back-button.tsx";
import { Button } from "@/ui/button.tsx";
import { CloseButton } from "@/ui/close-button.tsx";
import { DialogClose, DialogContent, DialogTitle } from "@/ui/dialog.tsx";

/** How a bot looks: its colour, head and eyes. */
export interface Look {
	color: AgentColor;
	shape: AgentShape;
	face: AgentFace;
}

/** How many looks are offered, with Customise after them, two rows of four. */
const LOOKS_OFFERED = 7;

/** How many models Suggested holds: the default, then those most bots use. */
const SUGGESTED_MODELS = 3;

/** A model the bot can think with, as the workspace lists those switched on. */
interface OfferedModel {
	modelId: string;
	displayName: string | null;
	providerName: string;
	providerPreset: ProviderPresetId | null;
	capabilities: readonly ProviderModelCapability[];
}

/** Which part of a look is being chosen. */
export type Part = "shape" | "eyes";

/**
 * Making a bot. At the left the bot as it will be, on a tint of its colour,
 * its name written over it, and a few looks drawn at random, with Customise
 * for its colour, head and eyes, which open at the right in place of the
 * models. At the right the models it can think with, the suggested first,
 * then each provider's. It starts by asking its creator what it's for in its
 * first chat.
 */
export function NewAgentDialog({
	podId,
	onCreated,
}: {
	/** The pod the bot is made in. */
	podId: string;
	onCreated: (agent: Agent) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [looks, setLooks] = useState(randomLooks);
	const [chosenLook, setChosenLook] = useState(0);
	const [customising, setCustomising] = useState(false);
	const [part, setPart] = useState<Part>("shape");
	const [chosenModel, setChosenModel] = useState<string>();
	const create = useCreateAgent(podId);
	const models = useModels();
	const offered: readonly OfferedModel[] = models.data?.models ?? [];
	// The default goes unoffered while a failed test has its provider off.
	const model =
		chosenModel ??
		offered.find((candidate) => candidate.modelId === models.data?.defaultModel)?.modelId ??
		offered[0]?.modelId;
	const trimmedName = name.trim();
	const look = looks[chosenLook] ?? looks[0] ?? { color: "violet", shape: "circle", face: "pill" };

	function change(changes: Partial<Look>) {
		setLooks(looks.map((one, index) => (index === chosenLook ? { ...one, ...changes } : one)));
	}

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!trimmedName || !model) return;
		try {
			// Made without a prompt, a bot starts by interviewing its creator.
			const agent = await create.mutateAsync({ name: trimmedName, model, ...look });
			await onCreated(agent);
		} catch {
			return;
		}
	}

	// A tint of the bot's colour, so the bot is shown in its own light.
	const stage = {
		background: `color-mix(in oklab, ${botColors[look.color].face} 9%, var(--list))`,
	};
	const canCreate = Boolean(trimmedName && model) && !create.isPending;
	// A phone has Create at the top, as its pages have their main action; one Create either way.
	const phone = !useMediaQuery(SIDE_BY_SIDE);

	return (
		<DialogContent
			showCloseButton={false}
			// On a phone, a page of its own, as tall as what the keyboard leaves.
			className="max-h-[calc(100dvh-20px)] gap-0 overflow-hidden p-0 sm:max-w-[780px] max-md:inset-0 max-md:flex max-md:h-[var(--visible-height,100dvh)] max-md:max-h-none max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:flex-col max-md:rounded-none"
		>
			<DialogTitle className="sr-only">New bot</DialogTitle>
			<form
				onSubmit={submit}
				className="flex min-h-0 min-w-0 flex-col max-md:flex-1 max-md:overflow-y-auto md:h-[580px] md:flex-row"
			>
				{phone ? (
					<PhoneNewBot
						stage={stage}
						name={name}
						onNameChange={setName}
						look={look}
						customising={customising}
						onCustomise={setCustomising}
						lookStep={<LookStep part={part} look={look} onPartChange={setPart} onChange={change} />}
						canCreate={canCreate}
						alerts={
							<>
								{create.error && (
									<Alert>
										{failureMessage(create.error, {
											Conflict: "A bot with that name already exists. Try another name.",
											Forbidden: "Only a workspace admin can create a bot.",
										})}
									</Alert>
								)}
								{models.error && (
									<Alert>Models could not be loaded. Close this and try again.</Alert>
								)}
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
							className="flex w-[300px] shrink-0 flex-col items-center gap-5 p-6 transition-colors"
							style={stage}
						>
							<input
								aria-label="Name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder="Name your bot"
								maxLength={64}
								autoComplete="off"
								// biome-ignore lint/a11y/noAutofocus: naming the bot is the one thing the dialog cannot guess.
								autoFocus
								className="mt-4 w-full rounded-xl border border-transparent bg-transparent px-3 py-2 text-center font-semibold text-[22px] text-foreground outline-none transition-colors placeholder:text-subtle-foreground hover:border-border-strong hover:bg-chip"
							/>
							<div className="grid flex-1 place-items-center">
								<AgentAvatar color={look.color} face={look.face} shape={look.shape} size={112} />
							</div>
							<LookGrid
								looks={looks}
								chosen={chosenLook}
								onChoose={(index) => {
									setChosenLook(index);
									setCustomising(false);
								}}
								customising={customising}
								onCustomise={() => setCustomising(!customising)}
							/>
							{create.error && (
								<Alert>
									{failureMessage(create.error, {
										Conflict: "A bot with that name already exists. Try another name.",
										Forbidden: "Only a workspace admin can create a bot.",
									})}
								</Alert>
							)}
							{models.error && <Alert>Models could not be loaded. Close this and try again.</Alert>}
							<Button type="submit" className="w-full" disabled={!canCreate}>
								Create
							</Button>
						</div>

						<div className="flex min-h-0 min-w-0 flex-1 flex-col border-border border-l bg-panel">
							{customising ? (
								<LookStep
									part={part}
									look={look}
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
 * model, with Close and Create at the top; and, from the bot's face, its look,
 * with Back. The face rises and shrinks while the name is typed, so the name
 * and the models stay in view above the keyboard.
 */
function PhoneNewBot({
	stage,
	name,
	onNameChange,
	look,
	customising,
	onCustomise,
	lookStep,
	canCreate,
	alerts,
	modelPicker,
}: {
	/** The bot's colour as a tint, behind its face. */
	stage: CSSProperties;
	name: string;
	onNameChange: (name: string) => void;
	look: Look;
	/** Whether the look's page is open. */
	customising: boolean;
	onCustomise: (customising: boolean) => void;
	/** The look's page: its shape, eyes and colour. */
	lookStep: ReactNode;
	canCreate: boolean;
	alerts: ReactNode;
	modelPicker: ReactNode;
}) {
	const [naming, setNaming] = useState(false);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header
				className="sticky top-0 z-10 grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 pt-[max(12px,env(safe-area-inset-top))] pb-2 transition-colors"
				style={stage}
			>
				<span className="flex justify-self-start">
					{customising ? (
						<button
							type="button"
							aria-label="Back"
							onClick={() => onCustomise(false)}
							className={BACK_BUTTON}
						>
							<BackChevron />
						</button>
					) : (
						<DialogClose aria-label="Close" className={BACK_BUTTON}>
							<X aria-hidden size={20} strokeWidth={2.25} />
						</DialogClose>
					)}
				</span>
				<span className="font-semibold text-[17px] text-foreground">
					{customising ? "Look" : "New bot"}
				</span>
				<span className="flex justify-self-end">
					{!customising && (
						<Button
							type="submit"
							size="sm"
							className="h-11 rounded-full px-5 text-[15px]"
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
					aria-label={customising ? undefined : "Change the look"}
					disabled={customising}
					onClick={() => onCustomise(true)}
					className={cn(
						"focus-ring relative flex justify-center rounded-3xl transition-[height] duration-300 ease-out motion-reduce:transition-none",
						naming || customising ? "h-14" : "h-28",
					)}
				>
					<span
						className={cn(
							"origin-top transition-transform duration-300 ease-out motion-reduce:transition-none",
							(naming || customising) && "scale-50",
						)}
					>
						<AgentAvatar color={look.color} face={look.face} shape={look.shape} size={112} />
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
							maxLength={64}
							autoComplete="off"
							className="h-12 w-full rounded-xl border border-border-strong bg-panel px-4 text-[16px] text-foreground outline-none placeholder:text-subtle-foreground focus:border-primary-tint-border"
						/>
						{alerts}
					</>
				)}
			</div>
			<div className="flex min-h-0 flex-1 flex-col border-border border-t bg-panel">
				{customising ? lookStep : modelPicker}
			</div>
		</div>
	);
}

/**
 * The looks to start from, two rows of four with Customise last, which opens
 * the chosen one's colour, head and eyes beside them. The chosen one is
 * ringed. Each is a native radio, so arrow keys move the choice.
 */
function LookGrid({
	looks,
	chosen,
	onChoose,
	customising,
	onCustomise,
}: {
	looks: readonly Look[];
	chosen: number;
	onChoose: (index: number) => void;
	customising: boolean;
	onCustomise: () => void;
}) {
	const group = useId();
	return (
		<fieldset className="m-0 grid grid-cols-4 gap-2 border-0 p-0">
			<legend className="sr-only">Looks</legend>
			{looks.map((look, index) => (
				<Tile
					// biome-ignore lint/suspicious/noArrayIndexKey: a look is changed in its place, so its place is its key.
					key={index}
					group={group}
					label={`${look.color} ${look.shape}`}
					chosen={index === chosen}
					onChoose={() => onChoose(index)}
					size="sm"
				>
					<AgentAvatar color={look.color} face={look.face} shape={look.shape} size={32} />
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
	const [search, setSearch] = useState("");
	const { agents } = useAgents();
	const list = useRef<HTMLDivElement>(null);
	const words = search.trim().toLowerCase();
	const usersOf = (modelId: string) =>
		agents?.filter((agent) => agent.model === modelId && agent.systemAgentKey === null).length ?? 0;
	const found = models.filter((model) =>
		[model.displayName ?? "", model.modelId, model.providerName].some((text) =>
			text.toLowerCase().includes(words),
		),
	);
	const suggested = words
		? []
		: [...models]
				.sort(
					(a, b) =>
						Number(b.modelId === defaultModel) - Number(a.modelId === defaultModel) ||
						usersOf(b.modelId) - usersOf(a.modelId),
				)
				.filter((model, index) => index === 0 || usersOf(model.modelId) > 0)
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
					<h2 className="m-0 flex-1 font-semibold text-[15px] text-foreground">Model</h2>
					<Close />
				</div>
				<div className="flex h-10 items-center gap-2 rounded-lg border border-border-strong px-3 focus-within:shadow-(--ring-shadow)">
					<Search
						aria-hidden
						size={15}
						strokeWidth={1.75}
						className="shrink-0 text-subtle-foreground"
					/>
					<input
						aria-label="Search models"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && found[0]) {
								event.preventDefault();
								onChoose(found[0].modelId);
								return;
							}
							moveFocus(event, null);
						}}
						placeholder={`Search ${countOf(models.length, "model", "models")}`}
						autoComplete="off"
						className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-subtle-foreground"
					/>
				</div>
			</div>
			<div ref={list} className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 max-md:max-h-96">
				{found.length === 0 && (
					<p className="m-0 px-2 py-3 text-[13px] text-muted-foreground">
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
			<h3 className="m-0 flex items-center gap-2 px-2 pt-2 pb-1.5 font-medium text-[12.5px] text-muted-foreground">
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
	reasoning: { icon: Brain, label: "reasons" },
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
					<span className="truncate font-medium text-[14px] text-foreground">
						{nameOfModel(model)}
					</span>
					{isDefault && (
						<span className="shrink-0 rounded-[4px] border border-border-strong px-1.5 font-medium text-[10.5px] text-muted-foreground leading-[16px]">
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
			<span
				aria-hidden
				className={cn(
					"grid size-[18px] shrink-0 place-items-center rounded-full border-[1.5px] transition-colors",
					chosen ? "border-foreground" : "border-disabled-foreground",
				)}
			>
				{chosen && <span className="size-2 rounded-full bg-foreground" />}
			</span>
		</button>
	);
}

/** Looks to start from, with no colour twice before every colour has been used. */
function randomLooks(): Look[] {
	const colors = [...shuffled(agentColors), ...shuffled(agentColors)].slice(0, LOOKS_OFFERED);
	return colors.map((color) => ({ color, shape: pick(agentShapes), face: pick(agentFaces) }));
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

/** A square to choose one look or part from, a native radio, ringed while it is chosen. */
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
				size === "sm" ? "size-14" : "size-[68px]",
				"grid shrink-0 cursor-pointer place-items-center rounded-xl transition-colors has-focus-visible:shadow-(--ring-shadow)",
				// One inset ring rather than a border round a fill, whose two rounded edges leave a seam.
				chosen ? "bg-chip shadow-[inset_0_0_0_1.5px_var(--subtle-foreground)]" : "hover:bg-chip",
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

/** The height of a right-hand page's title row, the same for the models and a look's parts. */
const HEADER_ROW = "flex h-[22px] shrink-0 items-center";

/** A step past the start: Back, and its title or tabs beside it. */
function StepHeader({ onBack, children }: { onBack?: () => void; children: ReactNode }) {
	return (
		// The same row as the models' title, so a step's tabs sit level with "Model".
		<div className="shrink-0 px-5 pt-5 pb-4">
			<div className={cn(HEADER_ROW, "gap-2")}>
				{onBack && (
					<button
						type="button"
						onClick={onBack}
						aria-label="Back"
						className="focus-ring -ml-1 grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
					>
						<ArrowLeft aria-hidden size={16} strokeWidth={1.75} />
					</button>
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
 * Every head shape, drawn bare in the look's colour, or every pair of eyes,
 * drawn alone, with the colours along the foot. Given `onDone`, Back returns
 * to where it was opened from; a bot's own editor shows it with nothing to
 * go back to.
 */
export function LookStep({
	part,
	look,
	onPartChange,
	onChange,
	onDone,
}: {
	part: Part;
	look: Look;
	onPartChange: (part: Part) => void;
	onChange: (changes: Partial<Look>) => void;
	/** Back from it to the models, in its own header; absent on a phone, whose Back is at the top of the page. */
	onDone?: () => void;
}) {
	const group = useId();
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<StepHeader onBack={onDone}>
				<div role="tablist" aria-label="Part" className="flex gap-4">
					{(["shape", "eyes"] as const).map((one) => (
						<button
							key={one}
							type="button"
							role="tab"
							aria-selected={part === one}
							onClick={() => onPartChange(one)}
							className={cn(
								"focus-ring rounded-sm font-semibold text-[15px] transition-colors",
								part === one ? "text-foreground" : "text-muted-foreground hover:text-foreground",
							)}
						>
							{one === "shape" ? "Shape" : "Eyes"}
						</button>
					))}
				</div>
			</StepHeader>
			<div role="tabpanel" className="flex min-h-0 min-w-0 flex-1 flex-col">
				<fieldset className="m-0 grid min-h-0 min-w-0 flex-1 auto-rows-min grid-cols-4 justify-items-center gap-2 overflow-y-auto border-0 px-5 pb-4">
					<legend className="sr-only">{part === "shape" ? "Shape" : "Eyes"}</legend>
					{part === "shape"
						? agentShapes.map((one) => (
								<Tile
									key={one}
									group={group}
									label={one}
									chosen={one === look.shape}
									onChoose={() => onChange({ shape: one })}
								>
									<span className="flex" style={{ color: botColors[look.color].face }}>
										<ShapeGlyph shape={one} size={44} />
									</span>
								</Tile>
							))
						: agentFaces.map((one) => (
								<Tile
									key={one}
									group={group}
									label={one}
									chosen={one === look.face}
									onChoose={() => onChange({ face: one })}
								>
									<span className="flex text-foreground">
										<EyesGlyph face={one} width={44} />
									</span>
								</Tile>
							))}
				</fieldset>
			</div>
			<div className="shrink-0 px-5 pb-5">
				<div className="rounded-2xl border border-border-strong px-4 py-3.5">
					<ColourRow value={look.color} onChange={(color) => onChange({ color })} />
				</div>
			</div>
		</div>
	);
}

/** The bot colours as round swatches, two rows of eight, the chosen one ringed. Each is a native radio. */
function ColourRow({
	value,
	onChange,
}: {
	value: AgentColor;
	onChange: (color: AgentColor) => void;
}) {
	const group = useId();
	return (
		// `min-w-0`: a fieldset is otherwise as wide as its swatches, and would push the preview aside.
		<fieldset className="m-0 grid min-w-0 grid-cols-8 justify-items-center gap-x-2 gap-y-3 border-0 p-0">
			<legend className="sr-only">Colour</legend>
			{agentColors.map((color) => (
				<label
					key={color}
					className="size-7 shrink-0 cursor-pointer rounded-full has-focus-visible:outline-2 has-focus-visible:outline-ring has-focus-visible:outline-offset-4"
					// Ringed by an outline set out from it, so the gap shows whatever is behind.
					style={{
						background: botColors[color].face,
						...(value === color && {
							outline: `2px solid ${botColors[color].face}`,
							outlineOffset: 2,
						}),
					}}
				>
					<input
						type="radio"
						name={group}
						aria-label={color}
						checked={value === color}
						onChange={() => onChange(color)}
						className="sr-only"
					/>
				</label>
			))}
		</fieldset>
	);
}

/** A model's provider, as its logo, or its initial when it has none. */
function ProviderMark({ model }: { model: OfferedModel }) {
	return model.providerPreset ? (
		<ProviderLogo preset={model.providerPreset} className="size-3.5 shrink-0" />
	) : (
		<span
			aria-hidden
			className="grid size-3.5 shrink-0 place-items-center rounded-[3px] bg-chip-strong text-[9px]"
		>
			{model.providerName.trim().charAt(0).toUpperCase()}
		</span>
	);
}
