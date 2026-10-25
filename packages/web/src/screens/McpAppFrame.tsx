import {
	AppBridge,
	type McpUiTheme,
	PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpAppResource, ToolCallPart } from "@sugabots/contracts";
import { withLeadingTags } from "@sugabots/contracts/artifact-pages";
import { cn } from "cn";
import { useEffect, useRef, useState } from "react";
import {
	callMcpAppTool,
	isCallToolResult,
	mcpAppContentPolicy,
	useMcpAppResource,
} from "@/lib/mcp-apps.ts";
import { Alert } from "@/ui/alert.tsx";
import { FIT_HEIGHT_PX, useAppTheme } from "./HtmlFrame.tsx";

/**
 * A tool call's output, shown in the MCP App its server made for the tool.
 *
 * The app's HTML comes from a server the pod connected to, so it is treated
 * as hostile, as a bot's page is (see `HtmlFrame`): it is written into a
 * frame sandboxed without `allow-same-origin`, under a policy that lets it
 * reach only the origins its server declared. It talks to the app over
 * `postMessage`, through `AppBridge`. It is given the call's input and
 * result, may call its server's tools back through the API, as whoever is
 * viewing, and may ask for links to be opened.
 */
export function McpAppFrame({ call, className }: { call: ToolCallPart; className?: string }) {
	const resource = useMcpAppResource(call.id);
	if (resource.isError) {
		return <Alert className={className}>This tool's app couldn't be shown.</Alert>;
	}
	if (!resource.data) {
		return <div style={{ height: FIT_HEIGHT_PX.min }} className={className} />;
	}
	return <BridgedFrame call={call} resource={resource.data} className={className} />;
}

function BridgedFrame({
	call,
	resource,
	className,
}: {
	call: ToolCallPart;
	resource: McpAppResource;
	className?: string;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState<number>(FIT_HEIGHT_PX.min);
	const { colorScheme } = useAppTheme();
	const theme: McpUiTheme = colorScheme.includes("light") ? "light" : "dark";
	const bridge = useRef<AppBridge | null>(null);
	const startingTheme = useRef(theme);

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
			void host.sendToolInput({ arguments: argumentsOf(call.input) });
			if (isCallToolResult(call.output)) void host.sendToolResult(call.output);
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
		// A new result or resource gives the app a fresh frame; a new theme is sent to the running one.
	}, [call.id, call.input, call.output, resource]);

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
			style={{ height: Math.min(height, FIT_HEIGHT_PX.max) }}
			className={cn(
				"block w-full bg-transparent",
				resource.prefersBorder === false ? "border-0" : "rounded-lg border border-border",
				className,
			)}
		/>
	);
}

function argumentsOf(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}
