import {
	type Artifact,
	type ArtifactAuthor,
	type ArtifactSummary,
	type ArtifactVersionSummary,
	isEditedLive,
	type LiveArtifactKind,
	type Pod,
} from "@sugabots/contracts";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import {
	Check,
	ChevronDown,
	FileCode,
	FileText,
	FileType,
	History,
	Maximize2,
	Minimize2,
	Play,
	Trash2,
	Upload,
} from "lucide-react";
import {
	type ComponentType,
	type CSSProperties,
	type ReactNode,
	useCallback,
	useRef,
	useState,
} from "react";
import {
	useArtifact,
	useArtifacts,
	useArtifactVersions,
	useDeleteArtifact,
} from "@/lib/artifacts.ts";
import { failureMessage } from "@/lib/failure.ts";
import { artifactLink, artifactsLink } from "@/lib/links.ts";
import { formatClockTime, formatListTime } from "@/lib/list-time.ts";
import { usePaneWidth } from "@/lib/pane-width.ts";
import { useSession } from "@/lib/session.ts";
import { Page } from "@/shell/Page.tsx";
import { type CloseStage, Stage, StageMark } from "@/shell/Stage.tsx";
import { useLeave } from "@/ui/back-button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { MoreMenu } from "@/ui/more-menu.tsx";
import { ResizeHandle } from "@/ui/resize-handle.tsx";
import { ArtifactShare, type ExportOption, powerPointExport } from "./ArtifactShare.tsx";
import { ARTIFACT_KINDS } from "./artifact-kinds.tsx";
import { LiveDeck, type Present } from "./LiveDeck.tsx";
import { downloadAsWord, LiveDocument } from "./LiveDocument.tsx";
import type { Editing, FileImport, LiveArtifact } from "./live-editor.tsx";
import type { AskedBot } from "./live-editor-overlays.tsx";

type Loading = "loading" | "failed";

/**
 * The documents, decks and pages a pod's bots have made, newest first, with the one
 * chosen open beside them, at its current version or the one `version` names.
 */
export function ArtifactsPage({
	pod,
	selectedId,
	version,
}: {
	pod: Pod;
	selectedId?: string;
	version?: number;
}) {
	const { data, isError } = useArtifacts(pod.id);
	const navigate = useNavigate();
	const router = useRouter();
	const { leaveForPage } = useLeave();
	return (
		<ArtifactListView
			pod={pod}
			artifacts={data ?? (isError ? "failed" : "loading")}
			selectedId={selectedId}
			now={new Date()}
		>
			{selectedId && (
				<ArtifactStage
					key={selectedId}
					pod={pod}
					artifactId={selectedId}
					version={version}
					onVersionChange={(version) => void navigate(artifactLink(pod, selectedId, { version }))}
					// Leaving in its place, as a deleted one is left, goes back to the list when that is behind.
					onClose={(how) =>
						how?.replace
							? leaveForPage(router.buildLocation(artifactsLink(pod)).href)
							: void navigate(artifactsLink(pod))
					}
				/>
			)}
		</ArtifactListView>
	);
}

export function ArtifactListView({
	pod,
	artifacts,
	selectedId,
	now,
	children,
}: {
	pod: Pod;
	artifacts: readonly ArtifactSummary[] | Loading;
	/** The artifact open beside the list, which its row marks. */
	selectedId?: string;
	now: Date;
	/** The artifact open beside the list, if one is. */
	children?: ReactNode;
}) {
	// As wide as the viewer last dragged it, or most of the page until they do.
	const [width, setWidth] = usePaneWidth("artifact");
	const pane = useRef<HTMLDivElement>(null);
	return (
		<div className="flex min-h-0 min-w-0 flex-1">
			<Page title="Artifacts" place={{ kind: "pod", pod }}>
				{artifacts !== "loading" && artifacts !== "failed" && artifacts.length === 0 ? (
					// As tall as the page leaves above the tabs, so there is nothing to scroll.
					<div className="flex h-above-tab-bar pb-20">
						<EmptyState
							title={`No artifacts in ${pod.name} yet`}
							icon={<FileText strokeWidth={1.75} />}
						>
							When a bot writes you a doc, report or page, it's saved here so the whole pod can find
							it later.
						</EmptyState>
					</div>
				) : (
					<div className="flex flex-col gap-5 px-4 pt-4 pb-12">
						{artifacts === "failed" ? (
							<EmptyState title="Could not load the artifacts">
								The API did not answer. Reload, or check that it is running.
							</EmptyState>
						) : artifacts === "loading" ? null : (
							byWhen(artifacts, now).map((group) => (
								<section
									key={group.label}
									aria-label={group.label}
									className="flex flex-col gap-0.5"
								>
									<h2 className="m-0 px-2 pb-1.5 font-medium text-subtle-foreground text-xs">
										{group.label}
									</h2>
									<ul className="m-0 flex list-none flex-col gap-0.5 p-0">
										{group.artifacts.map((artifact) => (
											<li key={artifact.id}>
												<ArtifactRow
													pod={pod}
													artifact={artifact}
													selected={artifact.id === selectedId}
													now={now}
												/>
											</li>
										))}
									</ul>
								</section>
							))
						)}
					</div>
				)}
			</Page>
			{children && (
				// Not positioned on a phone, where this pane has no width: the artifact covers the page instead.
				<div
					ref={pane}
					style={
						width === undefined ? undefined : ({ "--pane-width": `${width}px` } as CSSProperties)
					}
					className="flex min-h-0 min-w-0 border-border md:relative md:w-artifact-pane md:shrink-0 md:border-l"
				>
					<ResizeHandle
						label="Resize the artifact"
						pane={pane}
						edge="start"
						min={360}
						onResize={setWidth}
					/>
					{children}
				</div>
			)}
		</div>
	);
}

/** An artifact in the list: what kind it is, its title, which version, who made it, and when it last changed. */
function ArtifactRow({
	pod,
	artifact,
	selected,
	now,
}: {
	pod: Pod;
	artifact: ArtifactSummary;
	selected: boolean;
	now: Date;
}) {
	const kind = ARTIFACT_KINDS[artifact.kind];
	return (
		<Link
			{...artifactLink(pod, artifact.id)}
			aria-current={selected ? "page" : undefined}
			className={cn(
				"focus-ring flex items-center gap-3 rounded-lg p-2 transition-colors",
				selected ? "bg-row-selected" : "hover:bg-message-hover",
			)}
		>
			<KindMark kind={artifact.kind} />
			<span className="flex min-w-0 flex-1 flex-col leading-snug">
				<span className="truncate font-medium text-xs text-foreground">{artifact.title}</span>
				<span className="truncate text-subtle-foreground text-xs">
					{[kind.label, `v${artifact.version}`, artifact.createdBy?.name ?? "A removed bot"].join(
						", ",
					)}
				</span>
			</span>
			<time dateTime={artifact.updatedAt} className="shrink-0 text-subtle-foreground text-xs">
				{formatListTime(new Date(artifact.updatedAt), now)}
			</time>
		</Link>
	);
}

/**
 * An artifact opened large, at its current version or the one `version`
 * names. Those who may delete it can, which closes it.
 */
export function ArtifactStage({
	pod,
	artifactId,
	version,
	onVersionChange,
	onClose,
}: {
	pod: Pod;
	artifactId: string;
	version: number | undefined;
	/** `undefined` for the current version. */
	onVersionChange: (version: number | undefined) => void;
	onClose: CloseStage;
}) {
	const shown = useArtifact(pod.id, artifactId, version);
	const versions = useArtifactVersions(pod.id, artifactId);
	const remove = useDeleteArtifact(pod.id);
	const { user } = useSession();
	// A function kept in state is set with one that returns it, or React would call it.
	const [importFile, setImportFile] = useState<FileImport>();
	const [present, setPresent] = useState<Present>();
	const [presenceSlot, setPresenceSlot] = useState<HTMLElement | null>(null);
	const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
	const onImport = useCallback(
		(importer: FileImport | undefined) => setImportFile(() => importer),
		[],
	);
	const onPresent = useCallback(
		(presenter: Present | undefined) => setPresent(() => presenter),
		[],
	);
	// A document's or a deck's current version is edited where it is read; an earlier version is only read.
	const edited =
		shown.data &&
		isEditedLive(shown.data) &&
		shown.data.shownVersion.number === shown.data.version &&
		user
			? {
					artifact: shown.data,
					as: { name: user.name, email: user.email, image: user.image },
					Editor: LIVE_EDITORS[shown.data.kind],
				}
			: undefined;
	const deck = edited?.artifact.kind === "slides";
	async function deleteArtifact() {
		try {
			await remove.mutateAsync(artifactId);
		} catch {
			return;
		}
		// In the deleted artifact's place, so Back doesn't return to it.
		onClose({ replace: true });
	}
	return (
		<ArtifactStageView
			pod={pod}
			artifact={shown.data ?? (shown.isError ? "failed" : "loading")}
			versions={versions.data ?? []}
			now={new Date()}
			onVersionChange={onVersionChange}
			onClose={onClose}
			editor={
				edited && (
					<edited.Editor
						workspaceId={pod.workspaceId}
						artifact={edited.artifact}
						title={edited.artifact.title}
						as={edited.as}
						bot={edited.artifact.createdBy ?? undefined}
						onPresent={onPresent}
						onImport={onImport}
						presenceSlot={presenceSlot}
						statusSlot={statusSlot}
					/>
				)
			}
			presence={
				edited ? <span ref={setPresenceSlot} className="flex items-center gap-2" /> : undefined
			}
			status={edited ? <span ref={setStatusSlot} /> : undefined}
			present={deck ? present : undefined}
			officeFile={
				edited ? officeFileOf(edited.artifact.kind, pod.id, artifactId, importFile) : undefined
			}
			deletion={
				pod.permissions.deleteArtifacts
					? {
							pending: remove.isPending,
							error: remove.error ? failureMessage(remove.error) : undefined,
							onDelete: deleteArtifact,
						}
					: undefined
			}
		/>
	);
}

/** What the stage gives the editor of an artifact people edit live, whatever its kind. */
interface LiveEditing {
	workspaceId: string;
	artifact: LiveArtifact;
	title: string;
	as: Editing;
	bot: AskedBot | undefined;
	/** Given how to start presenting what is edited once the editor is up, for a kind that is presented. */
	onPresent: (present: Present | undefined) => void;
	/** Given how to replace what is edited with an office file's content once the editor is up. */
	onImport: (importFile: FileImport | undefined) => void;
	presenceSlot: HTMLElement | null;
	statusSlot: HTMLElement | null;
}

/**
 * The editor of each kind of artifact people edit live, which holds the
 * schema of the kind of the artifact it is given.
 */
const LIVE_EDITORS: Record<LiveArtifactKind, ComponentType<LiveEditing>> = {
	document: LiveDocument,
	slides: LiveDeck,
};

const DELETE_DESCRIPTION =
	"Every version goes with it, for everyone in the pod. Replies that showed it keep only its name. This can't be undone.";

/** The file each kind of artifact is kept as, as an export says it. */
const RAW_FILES = {
	document: { label: "Markdown", description: "Plain-text .md file", Icon: FileCode },
	slides: { label: "Markdown", description: "Plain-text .md file", Icon: FileCode },
	html: { label: "Web page", description: ".html file that opens in a browser", Icon: FileText },
} satisfies Record<Artifact["kind"], Omit<ExportOption, "onSave">>;

/**
 * What is being edited as the file of the office app made for its kind, a
 * Word document for a document and a PowerPoint presentation for a deck:
 * saved as one, which the API builds from its current version, and replaced
 * with one's content once the editor is up.
 */
interface OfficeFile {
	/** Saving it as one, a row of Share's exports. */
	exported: ExportOption;
	/** What the item of the ⋯ menu that replaces it with a file's content says. */
	importLabel: string;
	/** The files that item's picker offers. */
	accept: string;
	onImport: FileImport | undefined;
}

function officeFileOf(
	kind: LiveArtifactKind,
	podId: string,
	artifactId: string,
	onImport: FileImport | undefined,
): OfficeFile {
	if (kind === "slides") {
		return {
			exported: powerPointExport(podId, artifactId),
			importLabel: "Import from PowerPoint (.pptx)",
			accept: ".pptx",
			onImport,
		};
	}
	return {
		exported: {
			label: "Word",
			description: "Editable .docx document",
			Icon: FileType,
			onSave: () => downloadAsWord(podId, artifactId),
		},
		importLabel: "Import from Word (.docx)",
		accept: ".docx",
		onImport,
	};
}

/** Deleting what is shown, for those who may. */
interface Deletion {
	pending: boolean;
	error?: string;
	onDelete: () => void;
}

export function ArtifactStageView({
	pod,
	artifact,
	versions,
	now,
	onVersionChange,
	onClose,
	editor,
	presence,
	status,
	present,
	officeFile,
	deletion,
}: {
	pod: Pod;
	artifact: Artifact | Loading;
	/**
	 * Shown in place of the artifact's content, to edit it. Who wrote each
	 * version and when moves into the ⋯ menu with the versions, so the bar holds
	 * only what is used while writing.
	 */
	editor?: ReactNode;
	/** Who else has the artifact open, shown first among its controls. */
	presence?: ReactNode;
	/** Whether what is being edited is saved, after the title. */
	status?: ReactNode;
	/** Presents the deck being edited. Without it, there is no Present. */
	present?: Present;
	/** Without it, the artifact is neither saved as nor replaced with a Word or PowerPoint file. */
	officeFile?: OfficeFile;
	/** Newest first. */
	versions: readonly ArtifactVersionSummary[];
	now: Date;
	onVersionChange: (version: number | undefined) => void;
	onClose: CloseStage;
	/** Without it, there is no Delete. */
	deletion?: Deletion;
}) {
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [fullScreen, setFullScreen] = useState(false);
	const importedFile = useRef<HTMLInputElement>(null);
	const router = useRouter();
	if (typeof artifact !== "object") {
		return (
			<Stage label="Artifact" icon={null} title="" onClose={onClose}>
				{artifact === "failed" && (
					<EmptyState title="No such artifact here">
						It may have been removed, or the API did not answer.
					</EmptyState>
				)}
			</Stage>
		);
	}
	const kind = ARTIFACT_KINDS[artifact.kind];
	const shown = artifact.shownVersion;
	const link = () =>
		new URL(router.buildLocation(artifactLink(pod, artifact.id)).href, window.location.origin).href;
	const exports: ExportOption[] = [
		...(officeFile ? [officeFile.exported] : []),
		{ ...RAW_FILES[artifact.kind], onSave: () => downloadArtifact(artifact) },
	];
	return (
		<Stage
			label={artifact.title}
			icon={
				<StageMark>
					<kind.Icon strokeWidth={2} />
				</StageMark>
			}
			title={artifact.title}
			byline={
				editor ? undefined : (
					<>
						{shown.author?.name ?? "A removed bot"}{" "}
						<time dateTime={shown.createdAt}>{writtenWhen(new Date(shown.createdAt), now)}</time>
					</>
				)
			}
			note={status}
			fullScreen={{ on: fullScreen, onExit: () => setFullScreen(false) }}
			actions={
				<>
					{presence}
					{present && <PresentButton onClick={present} className="max-md:hidden" />}
					{!editor && (
						<VersionPicker
							artifact={artifact}
							versions={versions}
							now={now}
							onVersionChange={onVersionChange}
						/>
					)}
					{/* On a phone, a deck's Share sits beside Present, under the title. */}
					<span className={cn("contents", present && "max-md:hidden")}>
						<ArtifactShare title={artifact.title} pod={pod} link={link} exports={exports} />
					</span>
					<span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border-strong max-md:hidden" />
					<IconButton
						label={fullScreen ? "Exit full screen" : "Full screen"}
						variant="bar"
						aria-pressed={fullScreen}
						onClick={() => setFullScreen(!fullScreen)}
						className="max-md:hidden"
					>
						{fullScreen ? (
							<Minimize2 aria-hidden size={15} strokeWidth={1.75} />
						) : (
							<Maximize2 aria-hidden size={15} strokeWidth={1.75} />
						)}
					</IconButton>
					{(editor || officeFile?.onImport || deletion) && (
						<MoreMenu variant="bar">
							{editor && (
								<DropdownMenuSub>
									<DropdownMenuSubTrigger>
										<History aria-hidden />
										Version history
									</DropdownMenuSubTrigger>
									<DropdownMenuContent side="left" align="start">
										<VersionItems
											artifact={artifact}
											versions={versions}
											now={now}
											onVersionChange={onVersionChange}
										/>
									</DropdownMenuContent>
								</DropdownMenuSub>
							)}
							{officeFile?.onImport && (
								<DropdownMenuItem onClick={() => importedFile.current?.click()}>
									<Upload aria-hidden />
									{officeFile.importLabel}
								</DropdownMenuItem>
							)}
							{deletion && (
								<DropdownMenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
									<Trash2 aria-hidden />
									Delete
								</DropdownMenuItem>
							)}
						</MoreMenu>
					)}
				</>
			}
			onClose={onClose}
		>
			{present && (
				<div className="flex gap-2 pb-3 md:hidden">
					<PresentButton
						onClick={present}
						className="h-11 flex-1 justify-center rounded-md text-sm"
					/>
					{/* Its own button, made as large as Present's beside it. */}
					<span className="flex flex-1 [&>button]:h-11 [&>button]:flex-1 [&>button]:justify-center [&>button]:rounded-md [&>button]:text-sm">
						<ArtifactShare title={artifact.title} pod={pod} link={link} exports={exports} />
					</span>
				</div>
			)}
			{editor ?? (
				<kind.Full
					title={artifact.title}
					content={artifact.content}
					at={{ podId: artifact.podId, artifactId: artifact.id, version: shown.number }}
				/>
			)}
			{officeFile?.onImport && (
				// Outside the menu, which is gone by the time the person has chosen a file.
				<input
					ref={importedFile}
					type="file"
					accept={officeFile.accept}
					hidden
					onChange={(event) => {
						const [file] = event.target.files ?? [];
						if (file) void officeFile.onImport?.(file);
						event.target.value = "";
					}}
				/>
			)}
			{deletion && (
				<DeleteDialog
					open={confirmingDelete}
					onOpenChange={setConfirmingDelete}
					title={`Delete ${artifact.title}?`}
					description={DELETE_DESCRIPTION}
					pending={deletion.pending}
					error={deletion.error}
					onDelete={deletion.onDelete}
				/>
			)}
		</Stage>
	);
}

/** Starts presenting the deck, beside its Share. */
function PresentButton({ onClick, className }: { onClick: () => void; className?: string }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"focus-ring inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-border-strong bg-chip px-2.5 font-medium text-foreground text-xs transition-colors hover:bg-hover",
				className,
			)}
		>
			<Play aria-hidden size={13} className="fill-current" />
			Present
		</button>
	);
}

/** Which version is shown, and the others to switch to. */
function VersionPicker({
	artifact,
	versions,
	now,
	onVersionChange,
}: {
	artifact: Artifact;
	versions: readonly ArtifactVersionSummary[];
	now: Date;
	onVersionChange: (version: number | undefined) => void;
}) {
	const shown = artifact.shownVersion;
	const isCurrent = shown.number === artifact.version;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`Version ${shown.number} of ${artifact.version}`}
				className={cn(
					"focus-ring inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-border-strong pr-2 pl-2.5 text-xs transition-colors hover:bg-row-hover",
					// Round on glass on a phone, beside its ⋯.
					"max-md:glass max-md:h-11 max-md:rounded-full max-md:border-0 max-md:pr-3 max-md:pl-3.5 max-md:text-xs max-md:active:bg-hover-strong max-md:data-popup-open:bg-hover-strong",
					isCurrent ? "text-soft-foreground" : "text-foreground",
				)}
			>
				v{shown.number}
				{isCurrent ? "" : ` of ${artifact.version}`}
				<ChevronDown aria-hidden size={12} className="text-subtle-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<VersionItems
					artifact={artifact}
					versions={versions}
					now={now}
					onVersionChange={onVersionChange}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** An artifact's versions as menu items, the one shown ticked, each switching to it. */
function VersionItems({
	artifact,
	versions,
	now,
	onVersionChange,
}: {
	artifact: Artifact;
	versions: readonly ArtifactVersionSummary[];
	now: Date;
	onVersionChange: (version: number | undefined) => void;
}) {
	return versions.map((version) => (
		<DropdownMenuItem
			key={version.number}
			onClick={() =>
				onVersionChange(version.number === artifact.version ? undefined : version.number)
			}
		>
			<Check
				aria-hidden
				className={version.number === artifact.shownVersion.number ? undefined : "invisible"}
			/>
			<span className="flex-1">
				Version {version.number}
				<span className="text-muted-foreground"> {byline(version.author)}</span>
			</span>
			<time dateTime={version.createdAt} className="text-xs text-subtle-foreground">
				{formatListTime(new Date(version.createdAt), now)}
			</time>
		</DropdownMenuItem>
	));
}

/** When a version was written, to follow its author: "at 2:46", "yesterday", "on Mon", "on 14 Sep". */
function writtenWhen(at: Date, now: Date): string {
	const shown = formatListTime(at, now);
	if (shown === formatClockTime(at)) return `at ${shown}`;
	if (shown === "Yesterday") return "yesterday";
	return `on ${shown}`;
}

interface Group {
	/** "Today", "Earlier this week", then the month: "October", with its year when not this one. */
	label: string;
	artifacts: ArtifactSummary[];
}

const WEEK_MS = 7 * 24 * 60 * 60_000;

/** The artifacts, newest first, under when each was last updated: today, this week, then by month. */
function byWhen(artifacts: readonly ArtifactSummary[], now: Date): Group[] {
	const groups: Group[] = [];
	for (const artifact of artifacts) {
		const updated = new Date(artifact.updatedAt);
		const label =
			updated.toDateString() === now.toDateString()
				? "Today"
				: now.getTime() - updated.getTime() < WEEK_MS
					? "Earlier this week"
					: updated.toLocaleDateString(undefined, {
							month: "long",
							year: updated.getFullYear() === now.getFullYear() ? undefined : "numeric",
						});
		const last = groups.at(-1);
		if (last?.label === label) last.artifacts.push(artifact);
		else groups.push({ label, artifacts: [artifact] });
	}
	return groups;
}

/** Saves the artifact as shown, as a file named after its title. */
function downloadArtifact(artifact: Artifact) {
	const { extension, type, contentOf } = ARTIFACT_KINDS[artifact.kind].file;
	const url = URL.createObjectURL(new Blob([contentOf(artifact.content)], { type }));
	const link = document.createElement("a");
	link.href = url;
	link.download = fileNameFor(artifact.title, extension);
	link.click();
	// Safari reads the file after `click` returns, so it is let go of later, not at once.
	setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_READ_MS);
}

/** Long enough for any browser to have read a downloaded file before it is let go of. */
const DOWNLOAD_READ_MS = 60_000;

/** `title` as a file name ending in `.extension`, without the characters file systems refuse. */
function fileNameFor(title: string, extension: string): string {
	const name = title.replace(/[\\/:*?"<>|]+/g, "-").trim();
	return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

function KindMark({ kind }: { kind: ArtifactSummary["kind"] }) {
	const { Icon } = ARTIFACT_KINDS[kind];
	return (
		<span
			aria-hidden
			className="grid size-8 shrink-0 place-items-center rounded-md bg-chip text-muted-foreground"
		>
			<Icon size={16} strokeWidth={1.75} />
		</span>
	);
}

const byline = (author: ArtifactAuthor) => (author ? `by ${author.name}` : "by a removed bot");
