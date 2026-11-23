import {
	type FileAuthor,
	type FileSummary,
	type FileVersionSummary,
	isMessageFile,
	type MessageFileSummary,
	type WrittenFile,
	type WrittenFileSummary,
} from "@sugabots/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import { Check, ChevronDown, Download, FileText, Link2, Paperclip, Trash2 } from "lucide-react";
import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { conversationFileUrl } from "@/lib/conversation-files.ts";
import { API_DID_NOT_ANSWER, failureMessage } from "@/lib/failure.ts";
import { fileSizeLabel } from "@/lib/file-looks.ts";
import { useDeleteFile, useFile, useFiles, useFileVersions } from "@/lib/files.ts";
import { formatListTime, formatTimeAfterVerb } from "@/lib/list-time.ts";
import { FILE_PANE_MIN_WIDTH_PX, usePaneWidth } from "@/lib/pane-width.ts";
import {
	OwnerLink,
	ownerLinkOptions,
	ownerName,
	type ResourceOwner,
	resourcePermissions,
	resourceProjectId,
} from "@/lib/resource-owner.tsx";
import { OwnerCrumb } from "@/shell/BotCrumb.tsx";
import { Page } from "@/shell/Page.tsx";
import { type CloseStage, Stage } from "@/shell/Stage.tsx";
import { useLeave } from "@/ui/back-button.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { FileRow } from "@/ui/file-row.tsx";
import { IconTile } from "@/ui/icon-tile.tsx";
import { MoreMenu } from "@/ui/more-menu.tsx";
import { ResizeHandle } from "@/ui/resize-handle.tsx";
import { useCopy } from "@/ui/use-copy.ts";
import { FILE_KINDS } from "./file-kinds.tsx";

type Loading = "loading" | "failed";

/** Where `owner`'s files, or one of them at `version`, are, as an address. */
function useFileHref() {
	const router = useRouter();
	return (owner: ResourceOwner, fileId?: string, version?: number) =>
		router.buildLocation(
			ownerLinkOptions(owner, fileId ? { page: "file", fileId, version } : { page: "files" }),
		).href;
}

const REMOVED_BOT = "A removed bot";

/** Who wrote a file or a version of one, or that the bot that did is gone. */
function authorName(author: FileAuthor): string {
	return author?.name ?? REMOVED_BOT;
}

/**
 * The files uploaded or made in a project's threads, or in a bot's, newest
 * first: the files bots wrote, with the one chosen open beside them at
 * its current version or the one `version` names, and the files sent on
 * messages, which open on their own.
 */
export function FilesPage({
	owner,
	selectedId,
	version,
}: {
	owner: ResourceOwner;
	selectedId?: string;
	version?: number;
}) {
	const { data, isError } = useFiles(
		"project" in owner ? owner.project.id : owner.bot.defaultProjectId,
	);
	const navigate = useNavigate();
	const hrefOf = useFileHref();
	const { leaveForPage } = useLeave();
	return (
		<FileListView
			owner={owner}
			files={data ?? (isError ? "failed" : "loading")}
			selectedId={selectedId}
			now={new Date()}
		>
			{selectedId && (
				<FileStage
					key={selectedId}
					owner={owner}
					fileId={selectedId}
					version={version}
					onVersionChange={(version) => void navigate({ href: hrefOf(owner, selectedId, version) })}
					// Leaving in its place, as a deleted one is left, goes back to the list when that is behind.
					onClose={(how) =>
						how?.replace ? leaveForPage(hrefOf(owner)) : void navigate({ href: hrefOf(owner) })
					}
				/>
			)}
		</FileListView>
	);
}

export function FileListView({
	owner,
	files,
	selectedId,
	now,
	children,
}: {
	owner: ResourceOwner;
	files: readonly FileSummary[] | Loading;
	/** The file open beside the list, which its row marks. */
	selectedId?: string;
	now: Date;
	/** The file open beside the list, if one is. */
	children?: ReactNode;
}) {
	// As wide as the viewer last dragged it, or most of the page until they do.
	const [width, setWidth] = usePaneWidth("file");
	const pane = useRef<HTMLDivElement>(null);
	return (
		<div className="flex min-h-0 min-w-0 flex-1">
			<Page title="Files" parent={<OwnerCrumb owner={owner} />} place={{ kind: "owner", owner }}>
				{files !== "loading" && files !== "failed" && files.length === 0 ? (
					<EmptyState
						title={`No files from ${ownerName(owner)} yet`}
						page="fill"
						icon={<FileText strokeWidth={1.75} />}
					>
						When a bot writes you a doc, report or page, or someone sends a file, it's kept here so
						everyone can find it later.
					</EmptyState>
				) : (
					<div className="flex flex-col gap-5 px-4 pt-4 pb-12">
						{files === "failed" ? (
							<EmptyState title="Could not load the files">{API_DID_NOT_ANSWER}</EmptyState>
						) : files === "loading" ? null : (
							byWhen(files, now).map((group) => (
								<section
									key={group.label}
									aria-label={group.label}
									className="flex flex-col gap-0.5"
								>
									<h2 className="m-0 px-2 pb-1.5 font-medium text-subtle-foreground text-xs">
										{group.label}
									</h2>
									<ul className="m-0 flex list-none flex-col gap-0.5 p-0">
										{group.files.map((file) => (
											<li key={file.id}>
												<ListedFileRow
													owner={owner}
													file={file}
													selected={file.id === selectedId}
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
				// Not positioned on a phone, where this pane has no width: the file covers the page instead.
				<div
					ref={pane}
					style={
						width === undefined ? undefined : ({ "--pane-width": `${width}px` } as CSSProperties)
					}
					className="flex min-h-0 min-w-0 border-border md:relative md:w-file-pane md:shrink-0 md:border-l"
				>
					<ResizeHandle
						label="Resize the file"
						pane={pane}
						edge="start"
						min={FILE_PANE_MIN_WIDTH_PX}
						onResize={setWidth}
					/>
					{children}
				</div>
			)}
		</div>
	);
}

/** A file in the list: one a bot wrote, opened beside the list, or one sent on a message, opened on its own. */
function ListedFileRow({
	owner,
	file,
	selected,
	now,
}: {
	owner: ResourceOwner;
	file: FileSummary;
	selected: boolean;
	now: Date;
}) {
	return isMessageFile(file) ? (
		<MessageFileRow file={file} now={now} />
	) : (
		<WrittenFileRow owner={owner} file={file} selected={selected} now={now} />
	);
}

/** A file a bot wrote: what kind it is, its title, which version, who made it, and when it last changed. */
function WrittenFileRow({
	owner,
	file,
	selected,
	now,
}: {
	owner: ResourceOwner;
	file: WrittenFileSummary;
	selected: boolean;
	now: Date;
}) {
	const kind = FILE_KINDS[file.kind];
	return (
		<FileRow
			look="list"
			className={cn(
				"focus-ring transition-colors",
				selected ? "bg-row-selected" : "hover:bg-message-hover",
			)}
			render={
				<OwnerLink
					owner={owner}
					to={{ page: "file", fileId: file.id }}
					aria-current={selected ? "page" : undefined}
				/>
			}
			icon={
				<IconTile size="md">
					<kind.Icon size={16} strokeWidth={1.75} />
				</IconTile>
			}
			title={file.title}
			subtitle={[kind.label, `v${file.version}`, authorName(file.createdBy)].join(", ")}
			trailing={<ListTime at={file.updatedAt} now={now} />}
		/>
	);
}

/**
 * A file sent on a message: its name, size, who sent it and when. It opens
 * where the conversation serves it, as the message's own link does.
 */
function MessageFileRow({ file, now }: { file: MessageFileSummary; now: Date }) {
	const sentBy = file.sentBy ?? (file.kind === "upload" ? "Someone who left" : REMOVED_BOT);
	return (
		<FileRow
			look="list"
			className="focus-ring transition-colors hover:bg-message-hover"
			render={
				<a
					href={conversationFileUrl(file.conversationId, file.id)}
					target="_blank"
					rel="noreferrer"
				/>
			}
			icon={
				<IconTile size="md">
					<Paperclip size={16} strokeWidth={1.75} />
				</IconTile>
			}
			title={file.name}
			subtitle={[fileSizeLabel(file.size), sentBy].join(", ")}
			trailing={<ListTime at={file.updatedAt} now={now} />}
		/>
	);
}

/**
 * A file opened large, at its current version or the one `version` names.
 * Those who may delete it can, which closes it.
 */
export function FileStage({
	owner,
	fileId,
	version,
	onVersionChange,
	onClose,
}: {
	owner: ResourceOwner;
	fileId: string;
	version: number | undefined;
	/** `undefined` for the current version. */
	onVersionChange: (version: number | undefined) => void;
	onClose: CloseStage;
}) {
	const shown = useFile(fileId, version);
	const versions = useFileVersions(fileId);
	const ownerFiles = useFiles(resourceProjectId(owner));
	const remove = useDeleteFile();
	const mayDelete = resourcePermissions(owner).deleteFiles;
	// A file another project keeps is not shown here, where its link and Delete would be this owner's.
	const ownersFile = ownerFiles.data?.some((file) => file.id === fileId);
	const notOwners =
		ownerFiles.isError || (ownerFiles.isSuccess && !ownersFile && !ownerFiles.isFetching);
	async function deleteFile() {
		try {
			await remove.mutateAsync(fileId);
		} catch {
			return;
		}
		// In the deleted file's place, so Back doesn't return to it.
		onClose({ replace: true });
	}
	return (
		<FileStageView
			owner={owner}
			file={
				shown.isError || notOwners ? "failed" : ownersFile && shown.data ? shown.data : "loading"
			}
			versions={versions.data ?? []}
			now={new Date()}
			onVersionChange={onVersionChange}
			onClose={onClose}
			deletion={
				mayDelete
					? {
							pending: remove.isPending,
							error: remove.error ? failureMessage(remove.error) : undefined,
							onDelete: deleteFile,
						}
					: undefined
			}
		/>
	);
}

const DELETE_DESCRIPTION =
	"Every version goes with it, for everyone. Replies that showed it keep only its name. This can't be undone.";

/** Deleting what is shown, for those who may. */
interface Deletion {
	pending: boolean;
	error?: string;
	onDelete: () => void;
}

export function FileStageView({
	owner,
	file,
	versions,
	now,
	onVersionChange,
	onClose,
	deletion,
}: {
	owner: ResourceOwner;
	file: WrittenFile | Loading;
	/** Newest first. */
	versions: readonly FileVersionSummary[];
	now: Date;
	onVersionChange: (version: number | undefined) => void;
	onClose: CloseStage;
	/** Without it, there is no Delete. */
	deletion?: Deletion;
}) {
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const hrefOf = useFileHref();
	const copying = useCopy("Copy link");
	if (typeof file !== "object") {
		return (
			<Stage label="File" icon={null} title="" onClose={onClose}>
				{file === "failed" && (
					<EmptyState title="No such file here">
						It may have been removed, or the API did not answer.
					</EmptyState>
				)}
			</Stage>
		);
	}
	const kind = FILE_KINDS[file.kind];
	const shown = file.shownVersion;
	function copyLink() {
		if (typeof file !== "object") return;
		const href = hrefOf(owner, file.id);
		void copying.copy(new URL(href, window.location.origin).href);
	}
	return (
		<Stage
			label={file.title}
			icon={
				<IconTile size="sm">
					<kind.Icon strokeWidth={2} />
				</IconTile>
			}
			title={file.title}
			byline={
				<>
					{authorName(shown.author)}{" "}
					<time dateTime={shown.createdAt}>
						{formatTimeAfterVerb(new Date(shown.createdAt), now)}
					</time>
				</>
			}
			actions={
				<>
					<VersionPicker
						file={file}
						versions={versions}
						now={now}
						onVersionChange={onVersionChange}
					/>
					<MoreMenu>
						<DropdownMenuItem onClick={() => downloadFile(file)}>
							<Download aria-hidden />
							Download
						</DropdownMenuItem>
						{/* Left open, so it can say it copied. */}
						<DropdownMenuItem closeOnClick={false} onClick={copyLink}>
							{copying.copied ? <Check aria-hidden /> : <Link2 aria-hidden />}
							{copying.label}
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
				title={file.title}
				content={file.content}
				at={{ fileId: file.id, version: shown.number }}
			/>
			{deletion && (
				<DeleteDialog
					open={confirmingDelete}
					onOpenChange={setConfirmingDelete}
					title={`Delete ${file.title}?`}
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
	file,
	versions,
	now,
	onVersionChange,
}: {
	file: WrittenFile;
	versions: readonly FileVersionSummary[];
	now: Date;
	onVersionChange: (version: number | undefined) => void;
}) {
	const shown = file.shownVersion;
	const isCurrent = shown.number === file.version;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`Version ${shown.number} of ${file.version}`}
				className={cn(
					"focus-ring inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-border-strong pr-2 pl-2.5 text-xs transition-colors hover:bg-row-hover",
					// Round on glass on a phone, beside its ⋯.
					"max-md:glass max-md:h-11 max-md:rounded-full max-md:border-0 max-md:pr-3 max-md:pl-3.5 max-md:active:bg-hover-strong max-md:data-popup-open:bg-hover-strong",
					isCurrent ? "text-soft-foreground" : "text-foreground",
				)}
			>
				v{shown.number}
				{isCurrent ? "" : ` of ${file.version}`}
				<ChevronDown aria-hidden size={12} className="text-subtle-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{versions.map((version) => (
					<DropdownMenuItem
						key={version.number}
						onClick={() =>
							onVersionChange(version.number === file.version ? undefined : version.number)
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
						<time dateTime={version.createdAt} className="text-xs text-subtle-foreground">
							{formatListTime(new Date(version.createdAt), now)}
						</time>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

interface Group {
	/** "Today", "Earlier this week", then the month: "October", with its year when not this one. */
	label: string;
	files: FileSummary[];
}

const WEEK_MS = 7 * 24 * 60 * 60_000;

/** The files, newest first, under when each was last updated: today, this week, then by month. */
function byWhen(files: readonly FileSummary[], now: Date): Group[] {
	const groups: Group[] = [];
	for (const file of files) {
		const updated = new Date(file.updatedAt);
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
		if (last?.label === label) last.files.push(file);
		else groups.push({ label, files: [file] });
	}
	return groups;
}

/** Saves the file as shown, as a file named after its title. */
function downloadFile(file: WrittenFile) {
	const { extension, type, contentOf } = FILE_KINDS[file.kind].file;
	const url = URL.createObjectURL(new Blob([contentOf(file.content)], { type }));
	const link = document.createElement("a");
	link.href = url;
	link.download = fileNameFor(file.title, extension);
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

/** When a file in the list last changed, at the row's end. */
function ListTime({ at, now }: { at: string; now: Date }) {
	return (
		<time dateTime={at} className="shrink-0 text-subtle-foreground text-xs">
			{formatListTime(new Date(at), now)}
		</time>
	);
}

const byline = (author: FileAuthor) => `by ${author ? author.name : REMOVED_BOT.toLowerCase()}`;
