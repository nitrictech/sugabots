import { ArrowLeft, ArrowUp, File, Folder, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "@/ui/icon-button.tsx";
import { desktopServerUrl } from "./VncView.tsx";

/** Something in a folder, as the desktop server lists it. */
interface FolderEntry {
	name: string;
	kind: "folder" | "file";
	size: number;
	/** When it last changed, as an ISO timestamp, if the agent may see it. */
	modified: string | null;
}

/** What the desktop server answers about files. */
type FilesMessage =
	| { type: "listing"; path: string; entries: FolderEntry[] }
	| { type: "file"; path: string; mediaType: string; data: string; truncated: boolean }
	| { type: "refused"; path: string; reason: string };

/** What the browser shows: a folder's contents, a file, or why it can't. */
type Showing =
	| { kind: "loading" }
	| { kind: "folder"; path: string; entries: FolderEntry[] }
	| {
			kind: "file";
			path: string;
			mediaType: string;
			data: string;
			truncated: boolean;
			folder: string;
	  }
	| { kind: "refused"; path: string; reason: string };

/**
 * The files of the agent's sandbox, browsed here as the agent's user sees
 * them, starting in the thread's folder: folders to open, and text files and
 * images to look at. Only a person in control may browse; the sandbox
 * refuses anyone who only watches.
 */
export function FilesView({ threadId, agentId }: { threadId: string; agentId: string }) {
	const socket = useRef<WebSocket | undefined>(undefined);
	const [showing, setShowing] = useState<Showing>({ kind: "loading" });
	const folderNow = useRef(".");

	useEffect(() => {
		const opened = new WebSocket(desktopServerUrl(threadId, agentId, "files"));
		socket.current = opened;
		opened.onopen = () => opened.send(JSON.stringify({ type: "list", path: "." }));
		opened.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as FilesMessage;
			if (message.type === "listing") {
				folderNow.current = message.path;
				setShowing({ kind: "folder", path: message.path, entries: sorted(message.entries) });
			} else if (message.type === "file") {
				setShowing({ ...message, kind: "file", folder: folderNow.current });
			} else {
				setShowing({ kind: "refused", path: message.path, reason: message.reason });
			}
		};
		opened.onclose = () => {
			if (socket.current !== opened) return;
			setShowing({
				kind: "refused",
				path: folderNow.current,
				reason: "The files couldn't be reached. Close the window and open it again to retry.",
			});
		};
		return () => {
			socket.current = undefined;
			opened.close();
		};
	}, [threadId, agentId]);

	const ask = (type: "list" | "read", path: string) => {
		if (socket.current?.readyState !== WebSocket.OPEN) return;
		socket.current.send(JSON.stringify({ type, path }));
	};
	const folder = showing.kind === "folder" ? showing.path : folderNow.current;

	return (
		<div className="absolute inset-0 flex flex-col bg-panel text-sm">
			<div className="flex shrink-0 items-center gap-1 border-border border-b px-2 py-1.5">
				{showing.kind === "file" ? (
					<IconButton label="Back to the folder" onClick={() => ask("list", showing.folder)}>
						<ArrowLeft />
					</IconButton>
				) : (
					<IconButton label="Up a folder" onClick={() => ask("list", parentOf(folder))}>
						<ArrowUp />
					</IconButton>
				)}
				<IconButton label="Refresh" onClick={() => ask("list", folder)}>
					<RotateCw />
				</IconButton>
				<Breadcrumbs
					path={showing.kind === "loading" ? "" : showing.path}
					onOpen={(path) => ask("list", path)}
				/>
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{showing.kind === "loading" && <p className="m-0 p-4 text-muted-foreground">Opening…</p>}
				{showing.kind === "refused" && (
					<p className="m-0 p-4 text-muted-foreground">{showing.reason}</p>
				)}
				{showing.kind === "folder" && (
					<FolderListing
						entries={showing.entries}
						onOpen={(entry) =>
							ask(entry.kind === "folder" ? "list" : "read", `${showing.path}/${entry.name}`)
						}
					/>
				)}
				{showing.kind === "file" && <FileContents file={showing} />}
			</div>
		</div>
	);
}

/** Each folder of `path` from the root, to go back up to. */
function Breadcrumbs({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
	const parts = path.split("/").filter(Boolean);
	return (
		<nav
			aria-label="Path"
			className="flex min-w-0 flex-1 items-center overflow-x-auto px-1 text-[13px]"
		>
			<button
				type="button"
				onClick={() => onOpen("/")}
				className="focus-ring shrink-0 rounded px-1 text-muted-foreground hover:text-foreground"
			>
				/
			</button>
			{parts.map((part, index) => (
				<span key={parts.slice(0, index + 1).join("/")} className="flex shrink-0 items-center">
					<button
						type="button"
						onClick={() => onOpen(`/${parts.slice(0, index + 1).join("/")}`)}
						className="focus-ring rounded px-1 text-soft-foreground hover:text-foreground"
					>
						{part}
					</button>
					{index < parts.length - 1 && <span className="text-muted-foreground">/</span>}
				</span>
			))}
		</nav>
	);
}

function FolderListing({
	entries,
	onOpen,
}: {
	entries: FolderEntry[];
	onOpen: (entry: FolderEntry) => void;
}) {
	if (entries.length === 0) {
		return <p className="m-0 p-4 text-muted-foreground">This folder is empty.</p>;
	}
	return (
		<ul aria-label="Folder contents" className="m-0 list-none p-1">
			{entries.map((entry) => (
				<li key={entry.name}>
					<button
						type="button"
						onClick={() => onOpen(entry)}
						className="focus-ring flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover"
					>
						<span aria-hidden className="text-muted-foreground [&_svg]:size-4">
							{entry.kind === "folder" ? <Folder /> : <File />}
						</span>
						<span className="min-w-0 flex-1 truncate text-foreground">{entry.name}</span>
						{entry.kind === "file" && (
							<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
								{formattedSize(entry.size)}
							</span>
						)}
						<span className="w-36 shrink-0 text-right text-muted-foreground text-xs tabular-nums">
							{entry.modified ? new Date(entry.modified).toLocaleString() : ""}
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}

function FileContents({ file }: { file: Extract<Showing, { kind: "file" }> }) {
	const cutShort = file.truncated && (
		<p className="m-0 px-4 pt-3 text-muted-foreground text-xs">
			Only the start of this file is shown.
		</p>
	);
	if (file.mediaType.startsWith("image/")) {
		return (
			<div className="grid place-items-center p-4">
				<img
					src={`data:${file.mediaType};base64,${file.data}`}
					alt={nameOf(file.path)}
					className="max-h-full max-w-full"
				/>
			</div>
		);
	}
	if (file.mediaType === "text/plain") {
		return (
			<>
				{cutShort}
				<pre className="m-0 whitespace-pre-wrap break-words p-4 font-mono text-[12.5px] text-foreground">
					{decodedText(file.data)}
				</pre>
			</>
		);
	}
	return <p className="m-0 p-4 text-muted-foreground">This file can't be shown here.</p>;
}

/** Folders before files, each by name. */
function sorted(entries: FolderEntry[]) {
	return [...entries].sort((a, b) =>
		a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1,
	);
}

function parentOf(path: string) {
	const parent = path.replace(/\/[^/]*\/?$/, "");
	return parent === "" ? "/" : parent;
}

function nameOf(path: string) {
	return path.split("/").at(-1) ?? path;
}

function decodedText(base64: string) {
	return new TextDecoder().decode(
		Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
	);
}

function formattedSize(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
