import type {
	Artifact,
	ArtifactAuthor,
	ArtifactSummary,
	ArtifactVersionSummary,
	Pod,
} from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Check, ChevronDown, ChevronLeft, FileText, PanelsTopLeft } from "lucide-react";
import { useArtifact, useArtifacts, useArtifactVersions } from "@/lib/artifacts.ts";
import { artifactLink, artifactsLink } from "@/lib/links.ts";
import { formatListTime } from "@/lib/list-time.ts";
import { Panes } from "@/shell/Shell.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { HtmlFrame } from "./HtmlFrame.tsx";
import { MessageMarkdown } from "./MessageMarkdown.tsx";

type Loading = "loading" | "failed";

/** The documents and pages a pod's bots have made, newest first. */
export function ArtifactsPage({ pod }: { pod: Pod }) {
	const { data, isError } = useArtifacts(pod.id);
	return (
		<ArtifactListView
			pod={pod}
			artifacts={data ?? (isError ? "failed" : "loading")}
			now={new Date()}
		/>
	);
}

export function ArtifactListView({
	pod,
	artifacts,
	now,
}: {
	pod: Pod;
	artifacts: readonly ArtifactSummary[] | Loading;
	now: Date;
}) {
	return (
		<Panes>
			<header className="flex shrink-0 items-center px-6 pt-5 pb-3 max-md:px-4">
				<h1 className="m-0 font-extrabold text-[30px] text-foreground tracking-[-0.02em] md:text-xl">
					Artifacts
				</h1>
			</header>
			{artifacts === "failed" ? (
				<EmptyState title="Could not load the artifacts">
					The API did not answer. Reload, or check that it is running.
				</EmptyState>
			) : artifacts === "loading" ? null : artifacts.length === 0 ? (
				<EmptyState title={`No artifacts in ${pod.name} yet`}>
					Ask a bot for a plan, a report or a page to keep, and it is kept here.
				</EmptyState>
			) : (
				<ul className="m-0 flex list-none flex-col gap-0.5 overflow-y-auto px-3 pb-6 max-md:px-2">
					{artifacts.map((artifact) => (
						<li key={artifact.id}>
							<Link
								{...artifactLink(pod, artifact.id)}
								className="focus-ring flex items-center gap-3 rounded-[14px] px-3 py-2.5 transition-colors hover:bg-hover"
							>
								<KindMark kind={artifact.kind} />
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="truncate font-semibold text-foreground text-md">
										{artifact.title}
									</span>
									<span className="truncate text-muted-foreground text-sm">
										{describeKind(artifact.kind)} · {byline(artifact.createdBy)} · version{" "}
										{artifact.version}
									</span>
								</span>
								<time
									dateTime={artifact.updatedAt}
									className="shrink-0 text-sm text-subtle-foreground"
								>
									{formatListTime(new Date(artifact.updatedAt), now)}
								</time>
							</Link>
						</li>
					))}
				</ul>
			)}
		</Panes>
	);
}

/** One artifact, at its current version or the one `version` names. */
export function ArtifactPage({
	pod,
	artifactId,
	version,
}: {
	pod: Pod;
	artifactId: string;
	version?: number;
}) {
	const shown = useArtifact(pod.id, artifactId, version);
	const versions = useArtifactVersions(pod.id, artifactId);
	return (
		<ArtifactView
			pod={pod}
			artifact={shown.data ?? (shown.isError ? "failed" : "loading")}
			versions={versions.data ?? []}
			now={new Date()}
		/>
	);
}

export function ArtifactView({
	pod,
	artifact,
	versions,
	now,
}: {
	pod: Pod;
	artifact: Artifact | Loading;
	/** Newest first. */
	versions: readonly ArtifactVersionSummary[];
	now: Date;
}) {
	return (
		<Panes>
			<header className="flex shrink-0 flex-col gap-1 border-border border-b px-6 pt-4 pb-3 max-md:px-4">
				<Link
					{...artifactsLink(pod)}
					className="focus-ring inline-flex items-center gap-1 self-start rounded-md font-medium text-link text-sm"
				>
					<ChevronLeft aria-hidden size={14} />
					Artifacts
				</Link>
				{typeof artifact === "object" && (
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						<h1 className="m-0 min-w-0 flex-1 truncate font-extrabold text-foreground text-xl tracking-[-0.02em]">
							{artifact.title}
						</h1>
						<VersionPicker pod={pod} artifact={artifact} versions={versions} now={now} />
					</div>
				)}
			</header>
			{artifact === "failed" ? (
				<EmptyState title="No such artifact here">
					It may have been removed, or the API did not answer.
				</EmptyState>
			) : artifact === "loading" ? null : artifact.kind === "html" ? (
				<HtmlFrame html={artifact.content} title={artifact.title} className="min-h-0 flex-1" />
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto">
					<article className="mx-auto max-w-[760px] px-6 py-6 max-md:px-4">
						<MessageMarkdown text={artifact.content} mentionable={[]} />
					</article>
				</div>
			)}
		</Panes>
	);
}

/** Which version is shown, and the others to switch to. */
function VersionPicker({
	pod,
	artifact,
	versions,
	now,
}: {
	pod: Pod;
	artifact: Artifact;
	versions: readonly ArtifactVersionSummary[];
	now: Date;
}) {
	const shown = artifact.shownVersion;
	const isCurrent = shown.number === artifact.version;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className={cn(
					"focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-full bg-chip px-3 py-1.5 font-medium text-sm transition-colors hover:bg-hover",
					isCurrent ? "text-soft-foreground" : "text-foreground",
				)}
			>
				Version {shown.number}
				{isCurrent ? "" : ` of ${artifact.version}`} · {byline(shown.author)}
				<ChevronDown aria-hidden size={14} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{versions.map((version) => (
					<DropdownMenuItem
						key={version.number}
						render={
							<Link
								{...artifactLink(
									pod,
									artifact.id,
									version.number === artifact.version ? {} : { version: version.number },
								)}
							/>
						}
					>
						<Check
							aria-hidden
							className={version.number === shown.number ? undefined : "invisible"}
						/>
						<span className="flex-1">
							Version {version.number}
							<span className="text-muted-foreground"> · {byline(version.author)}</span>
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

function KindMark({ kind }: { kind: ArtifactSummary["kind"] }) {
	const Icon = kind === "html" ? PanelsTopLeft : FileText;
	return (
		<span
			aria-hidden
			className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-chip text-soft-foreground"
		>
			<Icon size={18} strokeWidth={2} />
		</span>
	);
}

const describeKind = (kind: ArtifactSummary["kind"]) => (kind === "html" ? "Page" : "Document");

const byline = (author: ArtifactAuthor) => (author ? `by ${author.name}` : "by a removed bot");
