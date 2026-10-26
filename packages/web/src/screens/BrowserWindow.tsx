import { cn } from "cn";
import { ArrowLeft, ArrowRight, Globe, LoaderCircle, Lock, Plus, RotateCw, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { IconButton } from "@/ui/icon-button.tsx";
import { DesktopWindow, type WindowFrame } from "./DesktopWindow.tsx";
import { desktopServerUrl } from "./VncView.tsx";

/** One of the browser's tabs, as the desktop server reports it. */
export interface BrowserTab {
	id: string;
	title: string;
	url: string;
	/** The page's icon, as a data: URL, if it has one. */
	icon?: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
}

/** What the desktop server sends about the browser's tabs, and which is in front. */
interface TabsMessage {
	type: "tabs";
	tabs: BrowserTab[];
	activeId?: string;
}

/** What the viewer sends. The server ignores it all from a viewer that only watches. */
type TabsCommand =
	| { type: "activate"; tabId: string }
	| { type: "newTab" }
	| { type: "closeTab"; tabId: string }
	| { type: "navigate"; url: string }
	| { type: "back" | "forward" | "reload" | "stop" };

/**
 * The agent's browser in a window, drawn like Chrome since the browser, in
 * kiosk mode, draws nothing of its own: its tabs in the title strip, and a
 * toolbar with back, forward, reload and the address over the page from
 * `display`. Unless `viewOnly`, the person can switch, open and close tabs,
 * and go where they like.
 */
export function BrowserWindow({
	threadId,
	agentId,
	viewOnly,
	display,
	...frame
}: WindowFrame & {
	threadId: string;
	agentId: string;
	viewOnly: boolean;
	display: ReactNode;
}) {
	const { tabs, activeId, send } = useBrowserTabs(threadId, agentId, viewOnly);
	const active = tabs.find((tab) => tab.id === activeId);
	return (
		<DesktopWindow
			{...frame}
			label="Browser"
			strip={{
				tabs: (
					<TabStrip
						tabs={tabs}
						activeId={activeId}
						viewOnly={viewOnly}
						onActivate={(tabId) => send({ type: "activate", tabId })}
						onClose={(tabId) => send({ type: "closeTab", tabId })}
						onNew={() => send({ type: "newTab" })}
					/>
				),
			}}
		>
			<div className="absolute inset-0 flex flex-col">
				<div className="flex h-10 shrink-0 items-center gap-0.5 border-border border-b bg-panel px-2">
					<IconButton
						label="Back"
						size="lg"
						disabled={viewOnly || !active?.canGoBack}
						onClick={() => send({ type: "back" })}
					>
						<ArrowLeft />
					</IconButton>
					<IconButton
						label="Forward"
						size="lg"
						disabled={viewOnly || !active?.canGoForward}
						onClick={() => send({ type: "forward" })}
					>
						<ArrowRight />
					</IconButton>
					{active?.loading ? (
						<IconButton
							label="Stop"
							size="lg"
							disabled={viewOnly}
							onClick={() => send({ type: "stop" })}
						>
							<X />
						</IconButton>
					) : (
						<IconButton
							label="Reload"
							size="lg"
							disabled={viewOnly || !active}
							onClick={() => send({ type: "reload" })}
						>
							<RotateCw />
						</IconButton>
					)}
					<AddressBar
						key={`${active?.id}:${active?.url}`}
						url={active?.url ?? ""}
						readOnly={viewOnly}
						onNavigate={(url) => send({ type: "navigate", url })}
					/>
				</div>
				<div className="relative min-h-0 flex-1">{display}</div>
			</div>
		</DesktopWindow>
	);
}

/**
 * The browser's tabs across the title strip, the one in front joined to the
 * toolbar below it, each closable, and a button to open another. They share
 * the room evenly, as Chrome's do, up to a comfortable width.
 */
function TabStrip({
	tabs,
	activeId,
	viewOnly,
	onActivate,
	onClose,
	onNew,
}: {
	tabs: BrowserTab[];
	activeId: string | undefined;
	viewOnly: boolean;
	onActivate: (tabId: string) => void;
	onClose: (tabId: string) => void;
	onNew: () => void;
}) {
	return (
		<div className="flex min-w-0 flex-1 items-end gap-1">
			<nav aria-label="The browser's tabs" className="flex min-w-0 items-end gap-px">
				{tabs.map((tab) => {
					const selected = tab.id === activeId;
					return (
						<div
							key={tab.id}
							className={cn(
								"group relative flex h-[32px] w-[220px] min-w-[56px] shrink items-center rounded-t-[9px] text-[12.5px]",
								selected
									? "bg-panel text-foreground"
									: "text-muted-foreground hover:bg-hover/60 hover:text-soft-foreground",
							)}
						>
							<button
								type="button"
								aria-current={selected ? "true" : undefined}
								title={tab.title || tab.url}
								disabled={viewOnly && !selected}
								onClick={() => onActivate(tab.id)}
								className="focus-ring flex h-full min-w-0 flex-1 items-center gap-2 rounded-t-[9px] pr-1 pl-3 text-left disabled:cursor-default"
							>
								<TabIcon tab={tab} />
								<span className="min-w-0 flex-1 truncate">{tabLabel(tab)}</span>
							</button>
							{!viewOnly && (
								<button
									type="button"
									aria-label={`Close ${tabLabel(tab)}`}
									onClick={() => onClose(tab.id)}
									className={cn(
										"focus-ring mr-1.5 grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3",
										!selected && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
									)}
								>
									<X />
								</button>
							)}
						</div>
					);
				})}
			</nav>
			{!viewOnly && (
				<IconButton label="New tab" className="mb-1" onClick={onNew}>
					<Plus />
				</IconButton>
			)}
		</div>
	);
}

/** A tab's icon: a spinner while it loads, the page's own icon, or a globe for a page without one. */
function TabIcon({ tab }: { tab: BrowserTab }) {
	if (tab.loading) {
		return (
			<LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground" />
		);
	}
	if (tab.icon) return <img src={tab.icon} alt="" className="size-4 shrink-0" />;
	return <Globe aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

/**
 * The browser's tabs and which is in front, from the desktop server while
 * mounted, and a way to change them, which does nothing while `viewOnly`.
 */
function useBrowserTabs(threadId: string, agentId: string, viewOnly: boolean) {
	const socket = useRef<WebSocket | undefined>(undefined);
	const [tabs, setTabs] = useState<BrowserTab[]>([]);
	const [activeId, setActiveId] = useState<string | undefined>(undefined);

	useEffect(() => {
		const opened = new WebSocket(desktopServerUrl(threadId, agentId, "tabs"));
		socket.current = opened;
		opened.onmessage = (event) => {
			const message = JSON.parse(String(event.data)) as TabsMessage;
			setTabs(message.tabs);
			setActiveId(message.activeId);
		};
		return () => {
			socket.current = undefined;
			opened.close();
		};
	}, [threadId, agentId]);

	const send = (command: TabsCommand) => {
		if (viewOnly || socket.current?.readyState !== WebSocket.OPEN) return;
		socket.current.send(JSON.stringify(command));
	};
	return { tabs, activeId, send };
}

/**
 * The address of the tab in front, shown without its scheme, as Chrome
 * shows it, until the person clicks in to replace it: an address, or words
 * to search for.
 */
function AddressBar({
	url,
	readOnly,
	onNavigate,
}: {
	url: string;
	readOnly: boolean;
	onNavigate: (url: string) => void;
}) {
	const [editing, setEditing] = useState<string | undefined>(undefined);
	const secure = url.startsWith("https://");
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (editing !== undefined) onNavigate(editing);
		setEditing(undefined);
		(document.activeElement as HTMLElement | null)?.blur();
	};
	return (
		<form
			onSubmit={submit}
			className="focus-within:shadow-(--ring-shadow) ml-1.5 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full bg-chip px-3.5"
		>
			<span aria-hidden className="text-muted-foreground [&_svg]:size-3.5">
				{secure ? <Lock /> : <Globe />}
			</span>
			<input
				aria-label="Address"
				placeholder="Search or type a URL"
				value={editing ?? shownAddress(url)}
				readOnly={readOnly}
				onFocus={(event) => {
					if (readOnly) return;
					setEditing(url === "about:blank" ? "" : url);
					requestAnimationFrame(() => event.target.select());
				}}
				onBlur={() => setEditing(undefined)}
				onKeyDown={(event) => {
					if (event.key !== "Escape") return;
					setEditing(undefined);
					event.currentTarget.blur();
				}}
				onChange={(event) => setEditing(event.target.value)}
				className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
			/>
		</form>
	);
}

/** An address as Chrome shows it at rest: without https:// or a lone trailing slash, and a new tab blank. */
function shownAddress(url: string) {
	if (url === "about:blank") return "";
	return url.replace(/^https:\/\//, "").replace(/^([^/]+)\/$/, "$1");
}

function tabLabel(tab: BrowserTab) {
	if (tab.url === "about:blank") return "New tab";
	return tab.title || tab.url;
}
