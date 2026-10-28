import type {
	Artifact,
	ArtifactAuthor,
	ArtifactSummary,
	ArtifactVersionSummary,
	Pod,
} from "@sugabots/contracts";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import { Check, ChevronDown, Download, FileText, Link2, Trash2 } from "lucide-react";
import { type CSSProperties, type ReactNode, useRef, useState } from "react";
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
import { Page } from "@/shell/Page.tsx";
import { Stage, StageMark } from "@/shell/Stage.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { MoreMenu } from "@/ui/more-menu.tsx";
import { ResizeHandle } from "@/ui/resize-handle.tsx";
import { ARTIFACT_KINDS } from "./artifact-kinds.tsx";

type Loading = "loading" | "failed";

/**
 * The documents and pages a pod's bots have made, newest first, with the one
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
					onClose={() => void navigate(artifactsLink(pod))}
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
			<Page title="Artifacts">
				{artifacts !== "loading" && artifacts !== "failed" && artifacts.length === 0 ? (
					<div className="flex h-full pb-[10%]">
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
				<div
					ref={pane}
					style={
						width === undefined ? undefined : ({ "--pane-width": `${width}px` } as CSSProperties)
					}
					className="relative flex min-h-0 min-w-0 border-border border-l md:w-[clamp(360px,var(--pane-width,58%),calc(100%_-_320px))] md:shrink-0"
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
				"focus-ring flex items-center gap-3 rounded-[10px] p-2 transition-colors",
				selected ? "bg-row-selected" : "hover:bg-message-hover",
			)}
		>
			<KindMark kind={artifact.kind} />
			<span className="flex min-w-0 flex-1 flex-col leading-snug">
				<span className="truncate font-medium text-[13px] text-foreground">{artifact.title}</span>
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
	onClose: () => void;
}) {
	const shown = useArtifact(pod.id, artifactId, version);
	const versions = useArtifactVersions(pod.id, artifactId);
	const remove = useDeleteArtifact(pod.id);
	async function deleteArtifact() {
		try {
			await remove.mutateAsync(artifactId);
		} catch {
			return;
		}
		onClose();
	}
	return (
		<ArtifactStageView
			pod={pod}
			artifact={shown.data ?? (shown.isError ? "failed" : "loading")}
			versions={versions.data ?? []}
			now={new Date()}
			onVersionChange={onVersionChange}
			onClose={onClose}
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

const DELETE_DESCRIPTION =
	"Every version goes with it, for everyone in the pod. Replies that showed it keep only its name. This can't be undone.";

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
	deletion,
}: {
	pod: Pod;
	artifact: Artifact | Loading;
	/** Newest first. */
	versions: readonly ArtifactVersionSummary[];
	now: Date;
	onVersionChange: (version: number | undefined) => void;
	onClose: () => void;
	/** Without it, there is no Delete. */
	deletion?: Deletion;
}) {
	const [confirmingDelete, setConfirmingDelete] = useState(false);
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
	function copyLink() {
		if (typeof artifact !== "object") return;
		const href = router.buildLocation(artifactLink(pod, artifact.id)).href;
		void navigator.clipboard?.writeText(new URL(href, window.location.origin).href).catch(() => {});
	}
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
				<>
					{shown.author?.name ?? "A removed bot"}{" "}
					<time dateTime={shown.createdAt}>{writtenWhen(new Date(shown.createdAt), now)}</time>
				</>
			}
			actions={
				<>
					<VersionPicker
						artifact={artifact}
						versions={versions}
						now={now}
						onVersionChange={onVersionChange}
					/>
					<MoreMenu>
						<DropdownMenuItem onClick={() => downloadArtifact(artifact)}>
							<Download aria-hidden />
							Download
						</DropdownMenuItem>
						<DropdownMenuItem onClick={copyLink}>
							<Link2 aria-hidden />
							Copy link
						</DropdownMenuItem>
						{deletion && (
							<DropdownMenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
								<Trash2 aria-hidden />
								Delete
							</DropdownMenuItem>
						)}
					</MoreMenu>
				</>
			}
			onClose={onClose}
		>
			<kind.Full
				title={artifact.title}
				content={artifact.content}
				at={{ podId: artifact.podId, artifactId: artifact.id, version: shown.number }}
			/>
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
					"focus-ring inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] border border-border-strong pr-2 pl-2.5 text-xs transition-colors hover:bg-row-hover",
					isCurrent ? "text-soft-foreground" : "text-foreground",
				)}
			>
				v{shown.number}
				{isCurrent ? "" : ` of ${artifact.version}`}
				<ChevronDown aria-hidden size={12} className="text-subtle-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{versions.map((version) => (
					<DropdownMenuItem
						key={version.number}
						onClick={() =>
							onVersionChange(version.number === artifact.version ? undefined : version.number)
						}
					>
						<Check
							aria-hidden
							className={version.number === shown.number ? undefined : "invisible"}
						/>
						<span className="flex-1">
							Version {version.number}
							<span className="text-muted-foreground"> {byline(version.author)}</span>
						</span>
						<time dateTime={version.createdAt} className="text-sm text-subtle-foreground">
							{formatListTime(new Date(version.createdAt), now)}
						</time>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
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
	URL.revokeObjectURL(url);
}

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
			className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-chip text-muted-foreground"
		>
			<Icon size={16} strokeWidth={1.75} />
		</span>
	);
}

const byline = (author: ArtifactAuthor) => (author ? `by ${author.name}` : "by a removed bot");
