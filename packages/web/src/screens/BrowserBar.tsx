import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { IconButton } from "@/ui/icon-button.tsx";
import { PillTabs } from "@/ui/pill-tabs.tsx";
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
 * The tabs and address bar of the agent's browser, which draws none of its
 * own, from the desktop server while mounted. Unless `viewOnly`, the person
 * can switch tabs, go back, forward, reload and type an address.
 */
export function BrowserBar({
	threadId,
	agentId,
	viewOnly,
}: {
	threadId: string;
	agentId: string;
	viewOnly: boolean;
}) {
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
	const active = tabs.find((tab) => tab.id === activeId);

	return (
		<div className="flex flex-col">
			{tabs.length > 0 && (
				<PillTabs
					label="The browser's tabs"
					tabs={tabs.map((tab) => ({ id: tab.id, label: tabLabel(tab) }))}
					selected={activeId ?? ""}
					onSelect={(tabId) => send({ type: "activate", tabId })}
				/>
			)}
			<div className="flex items-center gap-1 px-2 pb-2">
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
		</div>
	);
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
		<form onSubmit={submit} className="min-w-0 flex-1">
			<input
				aria-label="Address"
				value={typed}
				readOnly={readOnly}
				onChange={(event) => setTyped(event.target.value)}
				className="focus-ring h-7 w-full rounded-full bg-chip px-3 text-[13px] text-soft-foreground"
			/>
		</form>
	);
}

function tabLabel(tab: BrowserTab) {
	return tab.title || tab.url || "New tab";
}
