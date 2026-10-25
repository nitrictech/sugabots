import {
	AppBridge,
	type McpUiTheme,
	PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpAppResource, MessagePart, ToolCallPart } from "@sugabots/contracts";
import { withLeadingTags } from "@sugabots/contracts/artifact-pages";
import { cn } from "cn";
import { Maximize2 } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ConnectionLook } from "@/lib/connections.ts";
import {
	callMcpAppTool,
	isCallToolResult,
	mcpAppContentPolicy,
	useMcpAppResource,
} from "@/lib/mcp-apps.ts";
import { connectionLabel, splitToolKey } from "@/lib/tool-names.ts";
import { Stage } from "@/shell/Stage.tsx";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { FIT_HEIGHT_PX, useAppTheme } from "./HtmlFrame.tsx";

/**
 * How a conversation shows the MCP Apps its replies' calls were made with.
 * Only one app runs in the conversation at a time, so a long thread is not
 * a column of live apps; the others fold to a row that opens beside the chat.
 */
export interface AppsShown {
	/** The call whose app runs in the conversation. None while one is open beside it. */
	liveCallId: string | undefined;
	/** The call whose app is open beside the conversation. */
	stagedCallId: string | undefined;
	onOpen: (callId: string) => void;
	/** Asks the bot to say in words what an app that didn't open would have shown. */
	onAskToDescribe?: (app: AppIdentity) => void;
}

/** Which app a call's output is shown in, and who showed it. */
export interface AppIdentity {
	/** The connection's name, such as "tldraw". */
	name: string;
	presetId?: string;
	botName: string;
}

export function appIdentityOf(
	call: ToolCallPart,
	looks: ReadonlyMap<string, ConnectionLook>,
	botName: string,
): AppIdentity {
	const { handle } = splitToolKey(call.tool);
	const look = looks.get(handle);
	return { name: connectionLabel(handle, look?.name), presetId: look?.presetId, botName };
}

/** The calls among `parts` that have an app to show: made with an MCP App's tool, and finished. */
export function appCallsIn(parts: readonly MessagePart[]): ToolCallPart[] {
	return parts.filter(
		(part): part is ToolCallPart =>
			part.type === "tool_call" && part.hasApp === true && part.status === "completed",
	);
}

/** A reply's apps: the live one as a card, the rest as rows. */
export function McpApps({
	calls,
	looks,
	botName,
	shown,
	className,
}: {
	calls: readonly ToolCallPart[];
	looks: ReadonlyMap<string, ConnectionLook>;
	botName: string;
	/** Without it, every app runs, as in a side thread that cannot open one beside it. */
	shown?: AppsShown;
	className?: string;
}) {
	if (calls.length === 0) return null;
	return (
		<div className={cn("flex w-full max-w-[680px] flex-col gap-2", className)}>
			{calls.map((call) => {
				const app = appIdentityOf(call, looks, botName);
				if (!shown || call.id === shown.liveCallId) {
					return (
						<McpAppCard
							key={call.id}
							call={call}
							app={app}
							onOpen={shown && (() => shown.onOpen(call.id))}
							onAskToDescribe={shown?.onAskToDescribe}
						/>
					);
				}
				return (
					<McpAppRow
						key={call.id}
						app={app}
						staged={call.id === shown.stagedCallId}
						onOpen={() => shown.onOpen(call.id)}
					/>
				);
			})}
		</div>
	);
}

/** A call's app running in the conversation, under a header saying whose it is. */
function McpAppCard({
	call,
	app,
	onOpen,
	onAskToDescribe,
}: {
	call: ToolCallPart;
	app: AppIdentity;
	onOpen?: () => void;
	onAskToDescribe?: (app: AppIdentity) => void;
}) {
	return (
		<article
			aria-label={`${app.name}, shown by ${app.botName}`}
			className="overflow-hidden rounded-[12px] border border-border bg-panel"
		>
			<div className="flex flex-wrap items-center gap-2.5 border-border border-b px-3 py-2.5">
				<AppHeading app={app} byline={`Shown by ${app.botName}`} />
				{onOpen && (
					<Button variant="secondary" size="sm" onClick={onOpen}>
						<Maximize2 aria-hidden />
						Open beside chat
					</Button>
				)}
			</div>
			<McpAppBody call={call} app={app} onAskToDescribe={onAskToDescribe} />
		</article>
	);
}

/** An app folded to one row: an earlier one, or the one open beside the chat. */
function McpAppRow({
	app,
	staged,
	onOpen,
}: {
	app: AppIdentity;
	staged: boolean;
	onOpen: () => void;
}) {
	return (
		<article
			aria-label={`${app.name}, shown by ${app.botName}`}
			className={cn(
				"flex items-center gap-2.5 rounded-[12px] border bg-panel px-3 py-2.5",
				staged ? "border-primary" : "border-border",
			)}
		>
			<AppHeading app={app} byline={staged ? "Open on the right" : `Shown by ${app.botName}`} />
			{!staged && (
				<Button variant="secondary" size="sm" aria-label={`Open ${app.name}`} onClick={onOpen}>
					<Maximize2 aria-hidden />
					Open
				</Button>
			)}
		</article>
	);
}

function AppHeading({ app, byline }: { app: AppIdentity; byline: string }) {
	return (
		<>
			<ConnectionMark presetId={app.presetId} name={app.name} size="sm" />
			<span className="flex min-w-40 flex-1 flex-col gap-px">
				<span className="truncate font-medium text-foreground text-sm">{app.name}</span>
				<span className="truncate text-[12.5px] text-muted-foreground">{byline}</span>
			</span>
		</>
	);
}

/** A call's app open large beside the chat. */
export function McpAppStage({
	call,
	app,
	onClose,
	onAskToDescribe,
}: {
	/** Undefined when the call is not among the messages loaded. */
	call: ToolCallPart | undefined;
	app: AppIdentity | undefined;
	onClose: () => void;
	onAskToDescribe?: (app: AppIdentity) => void;
}) {
	if (!call || !app) {
		return (
			<Stage label="App" icon={null} title="App" onClose={onClose}>
				<p className="m-0 text-muted-foreground text-sm">
					This app's tool call isn't among the messages loaded. Load older messages, then open it
					again.
				</p>
			</Stage>
		);
	}
	return (
		<Stage
			label={app.name}
			icon={<ConnectionMark presetId={app.presetId} name={app.name} size="sm" />}
			title={app.name}
			byline={`Shown by ${app.botName}`}
			onClose={onClose}
		>
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel border border-border">
				<McpAppBody call={call} app={app} fill onAskToDescribe={onAskToDescribe} />
			</div>
		</Stage>
	);
}

/** The height an app is given while it opens, so the conversation doesn't jump when it arrives. */
const OPENING_HEIGHT_PX = 360;
/** How long an app has to answer the host before it is said not to have opened. */
const START_TIMEOUT_MS = 15_000;

type Standing = "opening" | "running" | "failed";

/**
 * A call's app, or what is happening instead: opening, or that it didn't
 * open, with a way to try again or to have the bot describe it.
 */
function McpAppBody({
	call,
	app,
	fill = false,
	onAskToDescribe,
}: {
	call: ToolCallPart;
	app: AppIdentity;
	/** Fills its container, as beside the chat, rather than taking the height the app asks for. */
	fill?: boolean;
	onAskToDescribe?: (app: AppIdentity) => void;
}) {
	const resource = useMcpAppResource(call.id);
	// Each try is a fresh frame; what it reached is kept against the try it belongs to.
	const [attempt, setAttempt] = useState(0);
	const [reached, setReached] = useState<{ attempt: number; standing: Standing }>({
		attempt: 0,
		standing: "opening",
	});
	const standing: Standing = resource.isError
		? "failed"
		: reached.attempt === attempt
			? reached.standing
			: "opening";

	useEffect(() => {
		if (!resource.data) return;
		const timeout = setTimeout(
			() =>
				setReached((current) =>
					current.attempt === attempt && current.standing === "running"
						? current
						: { attempt, standing: "failed" },
				),
			START_TIMEOUT_MS,
		);
		return () => clearTimeout(timeout);
	}, [resource.data, attempt]);

	function retry() {
		setAttempt((count) => count + 1);
		if (resource.isError) void resource.refetch();
	}

	return (
		<div
			className={cn("relative", fill && "flex min-h-0 flex-1 flex-col")}
			style={standing === "running" || fill ? undefined : { height: OPENING_HEIGHT_PX }}
		>
			{resource.data && standing !== "failed" && (
				<BridgedFrame
					key={attempt}
					call={call}
					resource={resource.data}
					fill={fill}
					hidden={standing === "opening"}
					onStarted={() => setReached({ attempt, standing: "running" })}
				/>
			)}
			{standing === "opening" && (
				<div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-panel">
					<span aria-hidden className="flex gap-1.5">
						<span className="size-2 animate-pulse rounded-full bg-subtle-foreground motion-reduce:animate-none" />
						<span className="size-2 animate-pulse rounded-full bg-subtle-foreground [animation-delay:150ms] motion-reduce:animate-none" />
						<span className="size-2 animate-pulse rounded-full bg-subtle-foreground [animation-delay:300ms] motion-reduce:animate-none" />
					</span>
					<span role="status" className="text-muted-foreground text-sm">
						Opening {app.name}
					</span>
				</div>
			)}
			{standing === "failed" && (
				<div className="absolute inset-0 flex flex-col justify-center gap-3 bg-panel px-4">
					<span role="alert" className="flex flex-col gap-0.5">
						<span className="font-semibold text-destructive-text text-sm">
							This app didn't open
						</span>
						<span className="text-[13px] text-muted-foreground">
							{app.name} isn't responding right now.
						</span>
					</span>
					<div className="flex flex-wrap gap-2">
						<Button variant="secondary" size="sm" onClick={retry}>
							Try again
						</Button>
						{onAskToDescribe && (
							<Button variant="secondary" size="sm" onClick={() => onAskToDescribe(app)}>
								Ask {app.botName} to describe it
							</Button>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * The app's HTML comes from a server the pod connected to, so it is treated
 * as hostile, as a bot's page is (see `HtmlFrame`): it is written into a
 * frame sandboxed without `allow-same-origin`, under a policy that lets it
 * reach only the origins its server declared. It talks to the app over
 * `postMessage`, through `AppBridge`. It is given the call's input and
 * result, may call its server's tools back through the API, as whoever is
 * viewing, and may ask for links to be opened.
 */
function BridgedFrame({
	call,
	resource,
	fill,
	hidden,
	onStarted,
}: {
	call: ToolCallPart;
	resource: McpAppResource;
	fill: boolean;
	/** Kept laid out but unseen while the app starts, so it can measure itself. */
	hidden: boolean;
	onStarted: () => void;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState<number>(FIT_HEIGHT_PX.min);
	const { colorScheme } = useAppTheme();
	const theme: McpUiTheme = colorScheme.includes("light") ? "light" : "dark";
	const bridge = useRef<AppBridge | null>(null);
	const startingTheme = useRef(theme);
	const started = useEffectEvent(onStarted);
	// Read as the app starts, so a refetched copy of the same call doesn't start it again.
	const sendCall = useEffectEvent((host: AppBridge) => {
		void host.sendToolInput({ arguments: argumentsOf(call.input) });
		if (isCallToolResult(call.output)) void host.sendToolResult(call.output);
	});

	// Connected before the HTML is written in, so the app's first message is heard.
	useEffect(() => {
		const iframe = frame.current;
		const view = iframe?.contentWindow;
		if (!iframe || !view) return;
		const host = new AppBridge(
			null,
			{ name: "Sugabots", version: "1" },
			{ openLinks: {}, serverTools: {}, logging: {} },
			{
				hostContext: {
					theme: startingTheme.current,
					platform: "web",
					displayMode: "inline",
					availableDisplayModes: ["inline"],
					containerDimensions: { maxHeight: FIT_HEIGHT_PX.max },
					locale: navigator.language,
					timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				},
			},
		);
		host.oninitialized = () => {
			sendCall(host);
			started();
		};
		host.onsizechange = ({ height: reported }) => {
			if (reported !== undefined) setHeight(Math.max(FIT_HEIGHT_PX.min, Math.ceil(reported)));
		};
		host.oncalltool = async (params) => {
			const result = await callMcpAppTool(call.id, params);
			if (!isCallToolResult(result)) throw new Error("The server's answer was not a tool result");
			return result;
		};
		host.onopenlink = async ({ url }) => {
			const opened = /^https?:\/\//i.test(url)
				? window.open(url, "_blank", "noopener,noreferrer")
				: null;
			return opened === null ? { isError: true } : {};
		};
		let closed = false;
		void host.connect(new PostMessageTransport(view, view)).then(() => {
			if (closed) return;
			bridge.current = host;
			iframe.srcdoc = withLeadingTags(
				resource.html,
				`<meta http-equiv="Content-Security-Policy" content="${mcpAppContentPolicy(resource.csp)}">`,
			);
		});
		return () => {
			closed = true;
			bridge.current = null;
			void host.teardownResource({}).catch(() => undefined);
			void host.close();
		};
	}, [call.id, resource]);

	useEffect(() => {
		// Before the app has initialized there is nobody to tell; it is given the theme it starts with.
		Promise.resolve(bridge.current?.sendHostContextChange({ theme })).catch(() => undefined);
	}, [theme]);

	return (
		<iframe
			ref={frame}
			title={`${call.tool} app`}
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
			style={fill ? undefined : { height: Math.min(height, FIT_HEIGHT_PX.max) }}
			className={cn(
				"block w-full border-0 bg-transparent",
				fill && "min-h-0 flex-1",
				hidden && "invisible",
			)}
		/>
	);
}

function argumentsOf(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}
