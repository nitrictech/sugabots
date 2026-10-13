import type {
	Agent,
	Artifact,
	ArtifactAuthor,
	ArtifactSummary,
	ArtifactVersionSummary,
	Pod,
} from "@sugabots/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import { Check, ChevronDown, Download, Link2, Trash2 } from "lucide-react";
import { useState } from "react";
import { useAgents } from "@/lib/agents.ts";
import {
	useArtifact,
	useArtifacts,
	useArtifactVersions,
	useDeleteArtifact,
	useFetchArtifact,
} from "@/lib/artifacts.ts";
import { failureMessage } from "@/lib/failure.ts";
import { agentChatLink, artifactLink, artifactsLink } from "@/lib/links.ts";
import { formatClockTime, formatListTime } from "@/lib/list-time.ts";
import { Panes } from "@/shell/Shell.tsx";
import { Stage, StageMark } from "@/shell/Stage.tsx";
import { Alert } from "@/ui/alert.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { MoreMenu } from "@/ui/more-menu.tsx";
import { ARTIFACT_KINDS } from "./artifact-kinds.tsx";

type Loading = "loading" | "failed";

/** The documents and pages a pod's bots have made, newest first. */
export function ArtifactsPage({ pod }: { pod: Pod }) {
	const { data, isError } = useArtifacts(pod.id);
	const fetchArtifact = useFetchArtifact(pod.id);
	const download = useMutation({
		mutationFn: async (artifactId: string) => downloadArtifact(await fetchArtifact(artifactId)),
	});
	const remove = useDeleteArtifact(pod.id);
	const { agents } = useAgents();
	return (
		<ArtifactListView
			pod={pod}
			artifacts={data ?? (isError ? "failed" : "loading")}
			agents={agents ?? []}
			now={new Date()}
			download={{
				error: download.error ? failureMessage(download.error) : undefined,
				onDownload: download.mutate,
			}}
			deletion={
				pod.permissions.deleteArtifacts
					? {
							pending: remove.isPending,
							error: remove.error ? failureMessage(remove.error) : undefined,
							onDelete: (artifactId, onDeleted) =>
								remove.mutate(artifactId, { onSuccess: onDeleted }),
						}
					: undefined
			}
		/>
	);
}

export function ArtifactListView({
	pod,
	artifacts,
	agents,
	now,
	download,
	deletion,
}: {
	pod: Pod;
	artifacts: readonly ArtifactSummary[] | Loading;
	/** The workspace's bots, whose chats the artifacts they made open in. */
	agents: readonly Agent[];
	now: Date;
	download: { error?: string; onDownload: (artifactId: string) => void };
	/** Without it, the rows have no Delete. */
	deletion?: {
		pending: boolean;
		error?: string;
		onDelete: (artifactId: string, onDeleted: () => void) => void;
	};
}) {
	const [confirmingDelete, setConfirmingDelete] = useState<ArtifactSummary>();
	return (
		<Panes>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-[960px] flex-col gap-7 px-4 pt-9 pb-12 md:px-8">
					<h1 className="m-0 px-3 font-bold text-[30px] text-foreground tracking-[-0.02em] max-md:px-1">
						Artifacts
					</h1>
					{download.error && (
						<Alert className="mx-3 max-md:mx-1">Could not download it. {download.error}</Alert>
					)}
					{artifacts === "failed" ? (
						<EmptyState title="Could not load the artifacts">
							The API did not answer. Reload, or check that it is running.
						</EmptyState>
					) : artifacts === "loading" ? null : artifacts.length === 0 ? (
						<EmptyState title={`No artifacts in ${pod.name} yet`}>
							Ask a bot for a plan, a report or a page to keep, and it is kept here.
						</EmptyState>
					) : (
						<div className="flex flex-col gap-6">
							{byMonth(artifacts, now).map((month) => (
								<section key={month.label} aria-label={month.label}>
									<h2 className="m-0 px-3 pb-1.5 font-medium text-sm text-subtle-foreground">
										{month.label}
									</h2>
									<ul className="m-0 flex list-none flex-col gap-0.5 p-0">
										{month.artifacts.map((artifact) => (
											<li
												key={artifact.id}
												className="flex items-center gap-3 rounded-[14px] pr-3 transition-colors hover:bg-hover"
											>
												<Link
													{...openingLink(pod, artifact, agents)}
													className="focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-[14px] py-2.5 pl-3"
												>
													<KindMark kind={artifact.kind} />
													<span className="flex min-w-0 flex-1 flex-col">
														<span className="truncate font-semibold text-foreground text-md">
															{artifact.title}
														</span>
														<span className="truncate text-muted-foreground text-sm">
															{artifact.createdBy
																? `By ${artifact.createdBy.name}`
																: "By a removed bot"}
														</span>
													</span>
													<time
														dateTime={artifact.updatedAt}
														className="shrink-0 text-sm text-subtle-foreground"
													>
														Updated {updatedWhen(new Date(artifact.updatedAt), now)}
													</time>
												</Link>
												<ArtifactMenu
													pod={pod}
													artifactId={artifact.id}
													label={`More for ${artifact.title}`}
													onDownload={() => download.onDownload(artifact.id)}
													onDelete={deletion && (() => setConfirmingDelete(artifact))}
												/>
											</li>
										))}
									</ul>
								</section>
							))}
						</div>
					)}
				</div>
			</div>
			{deletion && (
				<DeleteDialog
					open={confirmingDelete !== undefined}
					onOpenChange={(open) => {
						if (!open) setConfirmingDelete(undefined);
					}}
					title={`Delete ${confirmingDelete?.title ?? "this artifact"}?`}
					description={DELETE_DESCRIPTION}
					pending={deletion.pending}
					error={deletion.error}
					onDelete={() => {
						if (!confirmingDelete) return;
						deletion.onDelete(confirmingDelete.id, () => setConfirmingDelete(undefined));
					}}
				/>
			)}
		</Panes>
	);
}

/** One artifact on its own page, from the pod's list, which Close goes back to. */
export function ArtifactPage({
	pod,
	artifactId,
	version,
}: {
	pod: Pod;
	artifactId: string;
	version?: number;
}) {
	const navigate = useNavigate();
	return (
		<Panes>
			<ArtifactStage
				pod={pod}
				artifactId={artifactId}
				version={version}
				onVersionChange={(version) => void navigate(artifactLink(pod, artifactId, { version }))}
				onClose={() => void navigate(artifactsLink(pod))}
			/>
		</Panes>
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
					<ArtifactMenu
						pod={pod}
						artifactId={artifact.id}
						onDownload={() => downloadArtifact(artifact)}
						onDelete={deletion && (() => setConfirmingDelete(true))}
					/>
				</>
			}
			onClose={onClose}
		>
			<kind.Full title={artifact.title} content={artifact.content} />
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

/**
 * The ⋯ beside an artifact: download it, copy the address of its page to send
 * to someone else in the pod, and, given `onDelete`, delete it.
 */
function ArtifactMenu({
	pod,
	artifactId,
	label,
	onDownload,
	onDelete,
}: {
	pod: Pod;
	artifactId: string;
	label?: string;
	onDownload: () => void;
	onDelete?: () => void;
}) {
	const router = useRouter();
	function copyLink() {
		const href = router.buildLocation(artifactLink(pod, artifactId)).href;
		void navigator.clipboard?.writeText(new URL(href, window.location.origin).href).catch(() => {});
	}
	return (
		<MoreMenu label={label}>
			<DropdownMenuItem onClick={onDownload}>
				<Download aria-hidden />
				Download
			</DropdownMenuItem>
			<DropdownMenuItem onClick={copyLink}>
				<Link2 aria-hidden />
				Copy link
			</DropdownMenuItem>
			{onDelete && (
				<DropdownMenuItem variant="destructive" onClick={onDelete}>
					<Trash2 aria-hidden />
					Delete
				</DropdownMenuItem>
			)}
		</MoreMenu>
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
				className={cn(
					"focus-ring inline-flex h-[29px] shrink-0 items-center gap-1.5 rounded-full bg-chip px-3 font-medium text-sm transition-colors hover:bg-hover",
					isCurrent ? "text-soft-foreground" : "text-foreground",
				)}
			>
				Version {shown.number}
				{isCurrent ? "" : ` of ${artifact.version}`}
				<ChevronDown aria-hidden size={14} />
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

/**
 * Where an artifact in the list opens: large beside the chat of the bot that
 * made it, so what was said about it is there too, or on a page of its own
 * once that bot has been removed or has left the pod.
 */
function openingLink(pod: Pod, artifact: ArtifactSummary, agents: readonly Agent[]) {
	const maker = agents.find(
		(agent) => agent.id === artifact.createdBy?.agentId && agent.podId === pod.id,
	);
	return maker
		? agentChatLink({ pod, agent: maker }, { artifact: artifact.id })
		: artifactLink(pod, artifact.id);
}

interface Month {
	/** "October", with the year when it is not this one: "April 2025". */
	label: string;
	artifacts: ArtifactSummary[];
}

/** The artifacts, newest first, under the month each was last updated in. */
function byMonth(artifacts: readonly ArtifactSummary[], now: Date): Month[] {
	const months: Month[] = [];
	for (const artifact of artifacts) {
		const updated = new Date(artifact.updatedAt);
		const label = updated.toLocaleDateString(undefined, {
			month: "long",
			year: updated.getFullYear() === now.getFullYear() ? undefined : "numeric",
		});
		const last = months.at(-1);
		if (last?.label === label) last.artifacts.push(artifact);
		else months.push({ label, artifacts: [artifact] });
	}
	return months;
}

/** When an artifact was last updated, to follow "Updated": "at 2:46" today, else "Oct 2". */
function updatedWhen(at: Date, now: Date): string {
	if (at.toDateString() === now.toDateString()) return `at ${formatClockTime(at)}`;
	return at.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: at.getFullYear() === now.getFullYear() ? undefined : "numeric",
	});
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
			className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-chip text-soft-foreground"
		>
			<Icon size={18} strokeWidth={2} />
		</span>
	);
}

const byline = (author: ArtifactAuthor) => (author ? `by ${author.name}` : "by a removed bot");
