import { cn } from "cn";
import {
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	Briefcase,
	Eye,
	File,
	FileArchive,
	FileCode,
	FileImage,
	FileSpreadsheet,
	FileText,
	Folder,
	HardDrive,
	House,
	LayoutGrid,
	List,
	MessagesSquare,
	Upload,
} from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { IconButton } from "@/ui/icon-button.tsx";
import { DesktopWindow, type WindowFrame } from "./DesktopWindow.tsx";
import { FileDropTarget } from "./FileDropTarget.tsx";
import { desktopServerUrl } from "./VncView.tsx";

/** Something in a folder, as the desktop server lists it. */
export interface FolderEntry {
	name: string;
	kind: "folder" | "file";
	size: number;
	/** When it last changed, as an ISO timestamp, if the agent may see it. */
	modified: string | null;
}

/** A folder the sidebar keeps at hand. */
interface Place {
	kind: "thread" | "workspace" | "home" | "computer";
	path: string;
}

/** What the desktop server says about files. */
type FilesMessage =
	| { type: "places"; places: Place[] }
	| { type: "listing"; path: string; entries: FolderEntry[] }
	| { type: "file"; path: string; mediaType: string; data: string; truncated: boolean }
	| { type: "refused"; path: string; reason: string }
	| UploadReply;

type UploadReply =
	| { type: "upload-received"; id: string; bytes: number }
	| { type: "uploaded"; id: string; path: string }
	| { type: "upload-failed"; id: string; reason: string };

/** What the window shows: a folder's contents, a file, or why it can't. */
type Showing =
	| { kind: "loading" }
	| { kind: "folder"; path: string; entries: FolderEntry[] }
	| { kind: "file"; path: string; mediaType: string; data: string; truncated: boolean }
	| { kind: "refused"; path: string; reason: string };

/** Somewhere the window has been, to go back and forward between. */
interface Location {
	kind: "folder" | "file";
	path: string;
}

/** A file being put in the sandbox, or the last that failed to be. */
type UploadStanding =
	| { name: string; sentBytes: number; size: number; failure?: undefined }
	| { name: string; failure: string };

type ViewMode = "list" | "grid";
type SortKey = "name" | "size" | "modified";

const PLACE_NAMES: Record<Place["kind"], string> = {
	thread: "This thread",
	workspace: "Workspace",
	home: "Home",
	computer: "Computer",
};

const PLACE_ICONS: Record<Place["kind"], ReactNode> = {
	thread: <MessagesSquare />,
	workspace: <Briefcase />,
	home: <House />,
	computer: <HardDrive />,
};

/** How much of a file goes in each message while it uploads: small enough to show progress, big enough to be quick. */
const UPLOAD_CHUNK_BYTES = 512 * 1024;
/** How long to wait for the sandbox to take a piece of an upload before giving up on it. */
const UPLOAD_ANSWER_TIMEOUT_MS = 30_000;

/**
 * The files of the agent's sandbox, as the agents' user sees them, laid out
 * as Finder and GNOME Files lay theirs out: back and forward and the folder's
 * path along the top, places down the side, and the folder's contents as a
 * list or icons, kept current as they change. A click picks something, a
 * double click or Enter opens it, and text files and images open here. Files
 * dropped on the window, or picked with Upload, are put in the folder shown.
 * Only a person in control may browse; the sandbox refuses anyone who only
 * watches.
 */
export function FilesWindow({
	threadId,
	agentId,
	viewOnly,
	...frame
}: WindowFrame & { threadId: string; agentId: string; viewOnly: boolean }) {
	const files = useFiles(threadId, agentId, viewOnly);
	const { showing, places } = files;
	const [mode, setMode] = useState<ViewMode>("list");
	const [showHidden, setShowHidden] = useState(false);
	const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
		key: "name",
		descending: false,
	});
	const [selection, setSelection] = useState<{ folder: string; name: string }>();
	const picker = useRef<HTMLInputElement>(null);

	const folder = showing.kind === "folder" ? showing : undefined;
	const selected = folder && selection?.folder === folder.path ? selection.name : undefined;
	const entries = folder
		? sortedEntries(
				folder.entries.filter((entry) => showHidden || !entry.name.startsWith(".")),
				sort.key,
				sort.descending,
			)
		: [];
	const open = (entry: FolderEntry) => {
		if (!folder) return;
		files.visit({ kind: entry.kind, path: joined(folder.path, entry.name) });
	};
	const uploadable = !viewOnly && folder !== undefined;
	const upload = (dropped: File[]) => folder && files.upload(dropped, folder.path);

	return (
		<DesktopWindow
			{...frame}
			label="Files"
			strip={{
				toolbar: (
					<div className="flex min-w-0 flex-1 items-center gap-1 pl-1">
						<IconButton label="Back" size="lg" disabled={!files.canGoBack} onClick={files.back}>
							<ArrowLeft />
						</IconButton>
						<IconButton
							label="Forward"
							size="lg"
							disabled={!files.canGoForward}
							onClick={files.forward}
						>
							<ArrowRight />
						</IconButton>
						<PathBar
							path={showing.kind === "loading" ? "" : showing.path}
							home={places.find((place) => place.kind === "home")?.path}
							onOpen={(path) =>
								files.visit({
									kind: showing.kind === "file" && path === showing.path ? "file" : "folder",
									path,
								})
							}
						/>
						<IconButton
							label="Upload files"
							size="lg"
							disabled={!uploadable}
							onClick={() => picker.current?.click()}
						>
							<Upload />
						</IconButton>
						<input
							ref={picker}
							type="file"
							multiple
							hidden
							aria-label="Files to upload"
							onChange={(event) => {
								upload([...(event.currentTarget.files ?? [])]);
								event.currentTarget.value = "";
							}}
						/>
						<IconButton
							label={showHidden ? "Hide hidden files" : "Show hidden files"}
							size="lg"
							aria-pressed={showHidden}
							className="aria-pressed:bg-chip aria-pressed:text-foreground"
							onClick={() => setShowHidden(!showHidden)}
						>
							<Eye />
						</IconButton>
						<IconButton
							label={mode === "list" ? "Show as icons" : "Show as a list"}
							size="lg"
							onClick={() => setMode(mode === "list" ? "grid" : "list")}
						>
							{mode === "list" ? <LayoutGrid /> : <List />}
						</IconButton>
					</div>
				),
			}}
		>
			<div className="@container absolute inset-0 flex text-sm">
				{places.length > 0 && (
					<Sidebar
						places={places}
						current={showing.kind === "folder" ? showing.path : undefined}
						onOpen={(path) => files.visit({ kind: "folder", path })}
					/>
				)}
				<FileDropTarget
					heading="Drop files to upload"
					detail={folder ? `They'll be put in ${nameOf(folder.path) || "/"}.` : ""}
					onDropFiles={uploadable ? upload : undefined}
					className="flex min-w-0 flex-1 flex-col bg-panel"
				>
					<div className="min-h-0 flex-1 overflow-auto">
						{showing.kind === "loading" && <Notice>Opening…</Notice>}
						{showing.kind === "refused" && <Notice>{showing.reason}</Notice>}
						{showing.kind === "file" && <FileContents file={showing} />}
						{folder &&
							(entries.length === 0 ? (
								<Notice>This folder is empty.</Notice>
							) : mode === "list" ? (
								<ListView
									entries={entries}
									selected={selected}
									sort={sort}
									onSort={(key) =>
										setSort({
											key,
											descending: sort.key === key ? !sort.descending : false,
										})
									}
									onSelect={(name) => setSelection({ folder: folder.path, name })}
									onOpen={open}
								/>
							) : (
								<GridView
									entries={entries}
									selected={selected}
									onSelect={(name) => setSelection({ folder: folder.path, name })}
									onOpen={open}
								/>
							))}
					</div>
					<StatusBar
						entries={folder ? entries : undefined}
						selected={entries.find((entry) => entry.name === selected)}
						upload={files.uploading}
					/>
				</FileDropTarget>
			</div>
		</DesktopWindow>
	);
}

/**
 * The desktop server's files channel: what the window shows, where it has
 * been, and the files being uploaded. It connects again when the person
 * takes over or hands back, as the sandbox decides what a connection may do
 * when it's made.
 */
function useFiles(threadId: string, agentId: string, viewOnly: boolean) {
	const socket = useRef<WebSocket | undefined>(undefined);
	const [showing, setShowing] = useState<Showing>({ kind: "loading" });
	const [places, setPlaces] = useState<Place[]>([]);
	const [history, setHistory] = useState({ locations: [START] as Location[], index: 0 });
	const here = useRef<Location>(START);
	here.current = history.locations[history.index] ?? START;
	const awaiting = useRef(new Map<string, (reply: UploadReply | undefined) => void>());
	const [uploading, setUploading] = useState<UploadStanding>();

	const ask = useCallback((location: Location) => {
		if (socket.current?.readyState !== WebSocket.OPEN) return;
		const type = location.kind === "folder" ? "list" : "read";
		socket.current.send(JSON.stringify({ type, path: location.path }));
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: taking over or handing back needs a new connection, which the sandbox gives the new standing.
	useEffect(() => {
		const opened = new WebSocket(desktopServerUrl(threadId, agentId, "files"));
		socket.current = opened;
		setShowing({ kind: "loading" });
		setPlaces([]);
		// Asked for rather than sent on connecting, which the API's relay may not be passing on yet.
		opened.onopen = () => {
			opened.send(JSON.stringify({ type: "places" }));
			ask(here.current);
		};
		opened.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as FilesMessage;
			if (message.type === "places") return setPlaces(message.places);
			if (message.type === "listing") {
				return setShowing({ kind: "folder", path: message.path, entries: message.entries });
			}
			if (message.type === "file") return setShowing({ ...message, kind: "file" });
			if (message.type === "refused") {
				return setShowing({ kind: "refused", path: message.path, reason: message.reason });
			}
			awaiting.current.get(message.id)?.(message);
		};
		opened.onclose = () => {
			for (const reply of awaiting.current.values()) reply(undefined);
			if (socket.current !== opened) return;
			setShowing({
				kind: "refused",
				path: here.current.path,
				reason: "The files couldn't be reached. Close the window and open it again to retry.",
			});
		};
		return () => {
			socket.current = undefined;
			opened.close();
		};
	}, [threadId, agentId, viewOnly, ask]);

	const goTo = (index: number) => {
		const location = history.locations[index];
		if (!location) return;
		setHistory({ ...history, index });
		ask(location);
	};

	/** Sends `message` and waits for the sandbox's answer about upload `id`. */
	const exchange = (id: string, message: object) =>
		new Promise<UploadReply>((resolve, reject) => {
			const giveUp = setTimeout(() => {
				awaiting.current.delete(id);
				reject(new Error("The sandbox didn't answer."));
			}, UPLOAD_ANSWER_TIMEOUT_MS);
			awaiting.current.set(id, (reply) => {
				clearTimeout(giveUp);
				awaiting.current.delete(id);
				if (!reply) return reject(new Error("The files couldn't be reached."));
				if (reply.type === "upload-failed") return reject(new Error(reply.reason));
				resolve(reply);
			});
			socket.current?.send(JSON.stringify(message));
		});

	const uploadOne = async (file: File, folder: string) => {
		const id = crypto.randomUUID();
		setUploading({ name: file.name, sentBytes: 0, size: file.size });
		try {
			await readable(file);
			let reply = await exchange(id, {
				type: "upload",
				id,
				folder,
				name: file.name,
				size: file.size,
			});
			for (let offset = 0; reply.type !== "uploaded"; offset += UPLOAD_CHUNK_BYTES) {
				const data = await base64Of(file.slice(offset, offset + UPLOAD_CHUNK_BYTES));
				reply = await exchange(id, { type: "upload-chunk", id, data });
				if (reply.type === "upload-received") {
					setUploading({ name: file.name, sentBytes: reply.bytes, size: file.size });
				}
			}
			return true;
		} catch (error) {
			setUploading({ name: file.name, failure: (error as Error).message });
			return false;
		}
	};

	return {
		showing,
		places,
		uploading,
		canGoBack: history.index > 0,
		canGoForward: history.index < history.locations.length - 1,
		back: () => goTo(history.index - 1),
		forward: () => goTo(history.index + 1),
		visit(location: Location) {
			const shown = showing.kind === "loading" ? undefined : showing.path;
			if (location.path === shown && location.kind === showing.kind) return ask(location);
			const locations = [...history.locations.slice(0, history.index + 1), location];
			setHistory({ locations, index: locations.length - 1 });
			ask(location);
		},
		/** Puts `dropped` in `folder`, one after another, leaving the last that failed on show. */
		async upload(dropped: File[], folder: string) {
			let allUploaded = true;
			for (const file of dropped) allUploaded = (await uploadOne(file, folder)) && allUploaded;
			if (allUploaded) setUploading(undefined);
		},
	};
}

/** Where the window opens: the thread's folder, which the sandbox resolves relative paths from. */
const START: Location = { kind: "folder", path: "." };

/**
 * Fails for a folder dragged from the computer, which the browser hands over
 * as a file it can't read.
 */
async function readable(file: File) {
	try {
		await file.slice(0, 1).arrayBuffer();
	} catch {
		throw new Error("Folders can't be uploaded, only files.");
	}
}

function base64Of(blob: Blob) {
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
		reader.onerror = () => reject(new Error("The file couldn't be read."));
		reader.readAsDataURL(blob);
	});
}

/** The folder's path, from Home or the top of the sandbox, each folder on it a step back up. */
function PathBar({
	path,
	home,
	onOpen,
}: {
	path: string;
	home: string | undefined;
	onOpen: (path: string) => void;
}) {
	const bar = useRef<HTMLElement>(null);
	// A deep path shows its end, where the person is.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrolls again whenever the path changes.
	useLayoutEffect(() => {
		bar.current?.scrollTo({ left: bar.current.scrollWidth });
	}, [path]);
	const underHome = home !== undefined && (path === home || path.startsWith(`${home}/`));
	const root = underHome ? home : "/";
	const steps = path
		.slice(root.length)
		.split("/")
		.filter(Boolean)
		.map((name, index, names) => ({
			name,
			path: joined(root, names.slice(0, index + 1).join("/")),
		}));
	const crumb = (key: string, target: string, last: boolean, content: ReactNode) => (
		<button
			key={key}
			type="button"
			aria-current={last ? "location" : undefined}
			onClick={() => onOpen(target)}
			className={cn(
				"focus-ring flex h-6 shrink-0 items-center gap-1.5 rounded-[6px] px-1.5 hover:bg-hover [&_svg]:size-3.5",
				last ? "font-medium text-foreground" : "text-muted-foreground",
			)}
		>
			{content}
		</button>
	);
	return (
		<nav
			ref={bar}
			aria-label="Path"
			className="mx-1 flex h-[30px] min-w-0 flex-1 items-center overflow-x-auto rounded-[8px] bg-chip px-1 text-[13px] [scrollbar-width:none]"
		>
			{path &&
				crumb(
					"root",
					root,
					steps.length === 0,
					underHome ? (
						<>
							<House aria-hidden />
							Home
						</>
					) : (
						<HardDrive aria-label="Computer" />
					),
				)}
			{steps.map((step, index) => (
				<span key={step.path} className="flex shrink-0 items-center">
					<span aria-hidden className="px-0.5 text-subtle-foreground">
						/
					</span>
					{crumb(step.path, step.path, index === steps.length - 1, step.name)}
				</span>
			))}
		</nav>
	);
}

function Sidebar({
	places,
	current,
	onOpen,
}: {
	places: Place[];
	current: string | undefined;
	onOpen: (path: string) => void;
}) {
	return (
		<nav
			aria-label="Places"
			className="@max-[520px]:hidden flex w-[172px] shrink-0 flex-col gap-0.5 border-border border-r bg-aside p-2"
		>
			{places.map((place) => (
				<button
					key={place.kind}
					type="button"
					aria-current={place.path === current ? "location" : undefined}
					onClick={() => onOpen(place.path)}
					className={cn(
						"focus-ring flex h-8 items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[13px] text-soft-foreground hover:bg-hover [&_svg]:size-4 [&_svg]:shrink-0",
						"aria-[current]:bg-row-selected aria-[current]:font-medium aria-[current]:text-foreground",
					)}
				>
					<span aria-hidden className="text-muted-foreground">
						{PLACE_ICONS[place.kind]}
					</span>
					<span className="truncate">{PLACE_NAMES[place.kind]}</span>
				</button>
			))}
		</nav>
	);
}

/** What each of a folder's entries does when clicked, double-clicked and keyed. */
interface EntryHandlers {
	entries: FolderEntry[];
	selected: string | undefined;
	onSelect: (name: string) => void;
	onOpen: (entry: FolderEntry) => void;
}

/**
 * Enter opens the entry, as a double click does, and the arrow keys move to
 * the entry before or after it, picking it.
 */
function entryKeys(entry: FolderEntry, { onOpen, onSelect }: EntryHandlers) {
	return (event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			return onOpen(entry);
		}
		const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
		if (!step) return;
		const all = [
			...(event.currentTarget
				.closest("ul")
				?.querySelectorAll<HTMLButtonElement>("button[data-entry]") ?? []),
		];
		const next = all[all.indexOf(event.currentTarget) + step];
		if (!next?.dataset.entry) return;
		event.preventDefault();
		next.focus();
		onSelect(next.dataset.entry);
	};
}

function ListView({
	sort,
	onSort,
	...handlers
}: EntryHandlers & {
	sort: { key: SortKey; descending: boolean };
	onSort: (key: SortKey) => void;
}) {
	const { entries, selected, onSelect, onOpen } = handlers;
	const heading = (key: SortKey, label: string, className?: string) => (
		<button
			type="button"
			onClick={() => onSort(key)}
			className={cn(
				"focus-ring flex items-center gap-1 rounded px-1 hover:text-foreground [&_svg]:size-3",
				sort.key === key && "text-foreground",
				className,
			)}
		>
			{label}
			{sort.key === key && (sort.descending ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />)}
		</button>
	);
	return (
		<div className="p-1.5 pt-0">
			<div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_84px] @min-[560px]:grid-cols-[minmax(0,1fr)_84px_176px] items-center gap-3 border-border border-b bg-panel px-2.5 py-1.5 text-muted-foreground text-xs">
				{heading("name", "Name")}
				{heading("size", "Size", "justify-self-end")}
				{heading("modified", "Modified", "@max-[559px]:hidden")}
			</div>
			<ul aria-label="Folder contents" className="m-0 mt-1 list-none p-0">
				{entries.map((entry) => (
					<li key={entry.name}>
						<button
							type="button"
							data-entry={entry.name}
							aria-current={entry.name === selected ? "true" : undefined}
							onClick={() => onSelect(entry.name)}
							onDoubleClick={() => onOpen(entry)}
							onKeyDown={entryKeys(entry, handlers)}
							className={cn(
								"focus-ring grid w-full grid-cols-[minmax(0,1fr)_84px] @min-[560px]:grid-cols-[minmax(0,1fr)_84px_176px] items-center gap-3 rounded-[7px] px-2.5 py-[5px] text-left hover:bg-row-hover",
								"aria-[current]:bg-row-selected",
							)}
						>
							<span className="flex min-w-0 items-center gap-2.5">
								<EntryIcon entry={entry} className="size-[18px]" />
								<span className="truncate text-foreground">{entry.name}</span>
							</span>
							<span className="justify-self-end text-muted-foreground text-xs tabular-nums">
								{entry.kind === "folder" ? "—" : formattedSize(entry.size)}
							</span>
							<span className="@max-[559px]:hidden truncate text-muted-foreground text-xs tabular-nums">
								{entry.modified ? formattedDate(entry.modified) : ""}
							</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

function GridView(handlers: EntryHandlers) {
	const { entries, selected, onSelect, onOpen } = handlers;
	return (
		<ul
			aria-label="Folder contents"
			className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1 p-3"
		>
			{entries.map((entry) => (
				<li key={entry.name}>
					<button
						type="button"
						data-entry={entry.name}
						aria-current={entry.name === selected ? "true" : undefined}
						onClick={() => onSelect(entry.name)}
						onDoubleClick={() => onOpen(entry)}
						onKeyDown={entryKeys(entry, handlers)}
						className="focus-ring group flex w-full flex-col items-center gap-1.5 rounded-[10px] px-1.5 pt-3 pb-2 hover:bg-row-hover aria-[current]:bg-row-selected"
					>
						<EntryIcon entry={entry} className="size-11" strokeWidth={1.4} />
						<span className="line-clamp-2 w-full break-words text-center text-[12.5px] text-foreground leading-tight">
							{entry.name}
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}

/** A folder, in the link colour, or a file, drawn for its kind as its name's ending says. */
function EntryIcon({
	entry,
	className,
	strokeWidth = 1.75,
}: {
	entry: FolderEntry;
	className: string;
	strokeWidth?: number;
}) {
	if (entry.kind === "folder") {
		return (
			<Folder
				aria-hidden
				strokeWidth={strokeWidth}
				className={cn("shrink-0 fill-link/25 text-link", className)}
			/>
		);
	}
	const Icon = FILE_ICONS[extensionOf(entry.name)] ?? File;
	return (
		<Icon
			aria-hidden
			strokeWidth={strokeWidth}
			className={cn("shrink-0 text-muted-foreground", className)}
		/>
	);
}

const FILE_ICONS: Record<string, typeof File> = Object.fromEntries([
	...["txt", "md", "markdown", "rst", "log", "pdf", "doc", "docx", "rtf"].map((ending) => [
		ending,
		FileText,
	]),
	...["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"].map((ending) => [
		ending,
		FileImage,
	]),
	...["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"].map((ending) => [
		ending,
		FileArchive,
	]),
	...["csv", "tsv", "xls", "xlsx", "ods"].map((ending) => [ending, FileSpreadsheet]),
	...[
		"js",
		"mjs",
		"cjs",
		"ts",
		"tsx",
		"jsx",
		"json",
		"py",
		"rb",
		"go",
		"rs",
		"java",
		"c",
		"h",
		"cpp",
		"cs",
		"sh",
		"html",
		"css",
		"yaml",
		"yml",
		"toml",
		"xml",
		"sql",
		"nix",
	].map((ending) => [ending, FileCode]),
]);

/** How many things the folder shows, which is picked, or how an upload is going. */
function StatusBar({
	entries,
	selected,
	upload,
}: {
	/** The folder's entries as shown, unless a folder isn't. */
	entries: FolderEntry[] | undefined;
	selected: FolderEntry | undefined;
	upload: UploadStanding | undefined;
}) {
	const counted = entries && `${entries.length} ${entries.length === 1 ? "item" : "items"}`;
	return (
		<div className="flex h-7 shrink-0 items-center gap-3 border-border border-t px-3 text-muted-foreground text-xs">
			<span className="min-w-0 flex-1 truncate">
				{selected
					? `“${selected.name}” selected${selected.kind === "file" ? ` (${formattedSize(selected.size)})` : ""}`
					: counted}
			</span>
			{upload && <UploadProgress upload={upload} />}
		</div>
	);
}

function UploadProgress({ upload }: { upload: UploadStanding }) {
	if (upload.failure !== undefined) {
		return (
			<span role="status" className="min-w-0 truncate text-destructive-text">
				Couldn't upload “{upload.name}”: {upload.failure}
			</span>
		);
	}
	const fraction = upload.size === 0 ? 1 : upload.sentBytes / upload.size;
	return (
		<span role="status" className="flex min-w-0 items-center gap-2">
			<span className="truncate">Uploading “{upload.name}”</span>
			<span className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-chip">
				<span
					className="block h-full rounded-full bg-primary transition-[width]"
					style={{ width: `${Math.round(fraction * 100)}%` }}
				/>
			</span>
		</span>
	);
}

function Notice({ children }: { children: ReactNode }) {
	return <p className="m-0 p-4 text-muted-foreground">{children}</p>;
}

function FileContents({ file }: { file: Extract<Showing, { kind: "file" }> }) {
	if (file.mediaType.startsWith("image/")) {
		return (
			<div className="grid h-full place-items-center p-4">
				<img
					src={`data:${file.mediaType};base64,${file.data}`}
					alt={nameOf(file.path)}
					className="max-h-full max-w-full"
				/>
			</div>
		);
	}
	if (file.mediaType !== "text/plain") return <Notice>This file can't be shown here.</Notice>;
	return (
		<>
			{file.truncated && (
				<p className="m-0 px-4 pt-3 text-muted-foreground text-xs">
					Only the start of this file is shown.
				</p>
			)}
			<pre className="m-0 whitespace-pre-wrap break-words p-4 font-mono text-[12.5px] text-foreground">
				{decodedText(file.data)}
			</pre>
		</>
	);
}

/** Folders before files, each group by `key`, numbers in names in counting order. */
function sortedEntries(entries: FolderEntry[], key: SortKey, descending: boolean) {
	const byName = (a: FolderEntry, b: FolderEntry) =>
		a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
	const byKey = {
		name: byName,
		size: (a: FolderEntry, b: FolderEntry) => a.size - b.size || byName(a, b),
		modified: (a: FolderEntry, b: FolderEntry) =>
			(a.modified ?? "").localeCompare(b.modified ?? "") || byName(a, b),
	}[key];
	return [...entries].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
		return descending ? byKey(b, a) : byKey(a, b);
	});
}

function joined(folder: string, name: string) {
	return folder.endsWith("/") ? `${folder}${name}` : `${folder}/${name}`;
}

function nameOf(path: string) {
	return path.split("/").at(-1) ?? path;
}

function extensionOf(name: string) {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function decodedText(base64: string) {
	return new TextDecoder().decode(
		Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
	);
}

function formattedSize(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function formattedDate(timestamp: string) {
	return DATE_FORMAT.format(new Date(timestamp));
}
