import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { IconButton } from "@/ui/icon-button.tsx";
import { PillTabs } from "@/ui/pill-tabs.tsx";
import { DesktopWindow, type WindowFrame } from "./DesktopWindow.tsx";
import { desktopServerUrl } from "./VncView.tsx";

/** One of the browser's tabs, as the desktop server reports it. */
export interface BrowserTab {
	id: string;
	title: string;
	url: string;
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
	| { type: "navigate"; url: string }
	| { type: "back" | "forward" | "reload" };

/**
 * The agent's browser in a window: the page from `display`, with the
 * browser's address bar in the title strip and its tabs under it when there
 * is more than one, drawn here since the browser draws none of its own.
 * Unless `viewOnly`, the person can switch tabs, go back, forward, reload
 * and type an address.
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
			title={
				<div className="flex w-full max-w-[640px] items-center gap-0.5">
					<IconButton label="Back" disabled={viewOnly} onClick={() => send({ type: "back" })}>
						<ArrowLeft />
					</IconButton>
					<IconButton label="Forward" disabled={viewOnly} onClick={() => send({ type: "forward" })}>
						<ArrowRight />
					</IconButton>
					<IconButton label="Reload" disabled={viewOnly} onClick={() => send({ type: "reload" })}>
						<RotateCw />
					</IconButton>
					<AddressBar
						key={active?.url}
						url={active?.url ?? ""}
						readOnly={viewOnly}
						onNavigate={(url) => send({ type: "navigate", url })}
					/>
				</div>
			}
		>
			<div className="absolute inset-0 flex flex-col">
				{tabs.length > 1 && (
					<div className="border-border border-b bg-aside">
						<PillTabs
							label="The browser's tabs"
							tabs={tabs.map((tab) => ({ id: tab.id, label: tabLabel(tab) }))}
							selected={activeId ?? ""}
							onSelect={(tabId) => send({ type: "activate", tabId })}
						/>
					</div>
				)}
				<div className="relative min-h-0 flex-1">{display}</div>
			</div>
		</DesktopWindow>
	);
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

/** The address of the tab in front, which a person in control can replace and go to. */
function AddressBar({
	url,
	readOnly,
	onNavigate,
}: {
	url: string;
	readOnly: boolean;
	onNavigate: (url: string) => void;
}) {
	const [typed, setTyped] = useState(url);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		onNavigate(typed);
	};
	return (
		<form onSubmit={submit} className="ml-1 min-w-0 flex-1">
			<input
				aria-label="Address"
				placeholder="Search or type a URL"
				value={typed}
				readOnly={readOnly}
				onChange={(event) => setTyped(event.target.value)}
				className="focus-ring h-6 w-full rounded-[7px] bg-chip px-2.5 text-[12.5px] text-soft-foreground placeholder:text-muted-foreground"
			/>
		</form>
	);
}

function tabLabel(tab: BrowserTab) {
	return tab.title || tab.url || "New tab";
}
