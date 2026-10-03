import {
	type Connection,
	type ConnectionAccess,
	type ConnectionTool,
	type ConnectionToolWithAccess,
	connectionPresetFor,
	connectionToolMutating,
	type Pod,
} from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronDown, Ellipsis, Search } from "lucide-react";
import { type FormEvent, type ReactNode, useDeferredValue, useId, useState } from "react";
import { bearerAuthorization, useConnectionActions } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { podSettingsLink } from "@/lib/links.ts";
import { wordsFromKey } from "@/lib/tool-names.ts";
import { Alert, Success } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { SettingsGroup, SettingsPage, SettingsRow } from "@/ui/settings-page.tsx";
import {
	AccessMenu,
	type AccessSetting,
	AccessToggle,
	AccessValue,
	accessSettingOf,
} from "./tool-access.tsx";

/*
 * One connection, on a page of its own under its pod: its name, Disconnect,
 * and a menu with what keeps it working (signing in again, its secret, a
 * check that it answers); then its tools, those that read apart from those
 * that make changes, each group with Allow, Ask or Off for all of it and each
 * tool with its own.
 */

/** The docs on fixing a connection whose check failed. */
const TROUBLESHOOTING_URL = "https://sugabots.ai/docs/connections#troubleshooting";

/** More tools than this and the page offers to search them. */
const SEARCHABLE_TOOL_COUNT = 8;

export function ConnectionPage({
	connection,
	pod,
	back,
}: {
	connection: Connection;
	pod: Pod;
	/** The link back to the pod, or to wherever the page was opened from: a `PageBackLink`. */
	back: ReactNode;
}) {
	const canManage = pod.permissions.manageConnections;
	const actions = useConnectionActions(pod.id);
	const navigate = useNavigate();
	const [removing, setRemoving] = useState(false);
	const [replacingSecret, setReplacingSecret] = useState(false);
	const [query, setQuery] = useState("");
	const needle = useDeferredValue(query.trim().toLowerCase());
	const preset = connectionPresetFor(connection.url);
	const checked =
		actions.test.variables?.connectionId === connection.id ? actions.test.data : undefined;
	const failure = checked
		? !checked.reachable && (checked.error ?? "The server did not answer.")
		: connection.status === "error" && (connection.lastTestError ?? "The last check failed.");
	const error = actions.update.error ?? actions.signIn.error ?? actions.test.error;
	const matches = (tool: ConnectionTool) =>
		needle === "" ||
		tool.name.toLowerCase().includes(needle) ||
		wordsFromKey(tool.name).toLowerCase().includes(needle);
	const setToolAccess = (toolAccess: Record<string, ConnectionAccess>) =>
		actions.update.mutate({ connectionId: connection.id, json: { toolAccess } });
	const signIn = () => actions.signIn.mutate({ connectionId: connection.id });

	async function disconnect() {
		try {
			await actions.remove.mutateAsync({ connectionId: connection.id });
		} catch {
			return;
		}
		setRemoving(false);
		await navigate({ ...podSettingsLink(pod), replace: true });
	}

	return (
		<SettingsPage back={back}>
			<div className="flex items-center gap-3.5">
				<ConnectionMark presetId={preset?.id} name={connection.name} size="lg" />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h2 className="m-0 truncate font-bold text-[22px] text-foreground tracking-[-0.01em]">
						{connection.name}
					</h2>
					<p className="m-0 truncate text-[13px] text-muted-foreground">
						{connection.connectedBy
							? `${pod.name} pod connected by ${connection.connectedBy}`
							: `${pod.name} pod`}
					</p>
					{/* A catalog app is known by its name; only a server added by URL is told apart by it. */}
					{!preset && (
						<p className="m-0 truncate font-mono text-[12.5px] text-subtle-foreground">
							{connection.url}
						</p>
					)}
				</div>
				{/* On a phone it is in the menu, leaving the name its room. */}
				{canManage && (
					<Button
						size="sm"
						variant="secondary"
						className="max-md:hidden"
						onClick={() => setRemoving(true)}
					>
						Disconnect
					</Button>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger
						aria-label={`More for ${connection.name}`}
						className="focus-ring inline-flex size-[29px] shrink-0 cursor-pointer items-center justify-center rounded-full bg-chip text-foreground transition-colors hover:bg-hover [&_svg]:size-4"
					>
						<Ellipsis aria-hidden />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-48">
						{canManage && connection.auth === "oauth" && (
							<DropdownMenuItem onClick={signIn}>
								{connection.signedIn ? "Sign in again" : "Sign in"}
							</DropdownMenuItem>
						)}
						{canManage && connection.auth === "header" && (
							<DropdownMenuItem onClick={() => setReplacingSecret(true)}>
								{secretActionLabel(connection)}
							</DropdownMenuItem>
						)}
						<DropdownMenuItem onClick={() => actions.test.mutate({ connectionId: connection.id })}>
							Check connection
						</DropdownMenuItem>
						{canManage && (
							<DropdownMenuItem
								variant="destructive"
								className="md:hidden"
								onClick={() => setRemoving(true)}
							>
								Disconnect
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{/* Hidden while none of what it may show applies, so it leaves no gap. */}
			<div className="flex flex-col gap-3 empty:hidden">
				{!connection.signedIn && (
					<SettingsGroup>
						<SettingsRow
							label="Not signed in yet"
							sub={`Bots can't use ${connection.name} until someone signs in.`}
							trailing={
								canManage && (
									<Button size="sm" disabled={actions.signIn.isPending} onClick={signIn}>
										Sign in
									</Button>
								)
							}
						/>
					</SettingsGroup>
				)}
				{replacingSecret && (
					<SecretForm
						connection={connection}
						podId={pod.id}
						done={() => setReplacingSecret(false)}
					/>
				)}
				{actions.test.isPending && (
					<p className="m-0 px-1 text-muted-foreground text-sm">Checking the connection…</p>
				)}
				{failure && !actions.test.isPending && (
					<Alert>
						{failure}{" "}
						<a
							href={TROUBLESHOOTING_URL}
							target="_blank"
							rel="noreferrer"
							className="focus-ring rounded-sm font-medium text-link"
						>
							How to fix this
						</a>
					</Alert>
				)}
				{failure && canManage && connection.auth === "header" && !replacingSecret && (
					<Button
						size="sm"
						variant="secondary"
						className="self-start"
						onClick={() => setReplacingSecret(true)}
					>
						{secretActionLabel(connection)}
					</Button>
				)}
				{checked?.reachable && !actions.test.isPending && <Success>Connection successful</Success>}
				{error && <Alert>{failureMessage(error)}</Alert>}
			</div>
			{connection.tools.length === 0 ? (
				<SettingsGroup label="Tools">
					<SettingsRow label="No actions found yet." />
				</SettingsGroup>
			) : (
				<div className="flex flex-col gap-5">
					<div className="flex flex-col gap-1 px-1">
						<h3 className="m-0 font-semibold text-[15px] text-foreground">Tool permissions</h3>
						<p className="m-0 text-sm text-subtle-foreground">
							Ask means the bot waits for approval first. Off means it can't use that tool at all.
							These apply to every bot in {pod.name}.
						</p>
					</div>
					{connection.tools.length > SEARCHABLE_TOOL_COUNT && (
						<label className="focus-ring-within flex items-center gap-[9px] rounded-xl bg-chip px-3">
							<Search aria-hidden size={15} className="shrink-0 text-muted-foreground" />
							<input
								type="search"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder={`Search ${connection.tools.length} tools`}
								aria-label="Search tools"
								className="min-w-0 flex-1 bg-transparent py-[9px] text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
							/>
						</label>
					)}
					{toolGroups(connection.tools).map((group) => (
						<ToolGroup
							key={group.label}
							label={group.label}
							tools={group.tools}
							setting={group.setting}
							shown={group.tools.filter(matches)}
							canManage={canManage}
							setToolAccess={setToolAccess}
						/>
					))}
				</div>
			)}
			<DeleteDialog
				open={removing}
				onOpenChange={setRemoving}
				title={`Disconnect ${connection.name}?`}
				description="Bots in this pod can no longer use its tools. Connecting it again means signing in or entering its details again."
				confirmLabel="Disconnect"
				pending={actions.remove.isPending}
				error={actions.remove.error ? failureMessage(actions.remove.error) : undefined}
				onDelete={disconnect}
			/>
		</SettingsPage>
	);
}

/** What changing a header connection's secret is called: adding one, or replacing the one it has. */
function secretActionLabel(connection: Connection): string {
	if (connection.secretHeader === null) return "Add access token";
	return connection.hasSecret ? "Replace secret" : "Add secret";
}

/** A new secret for a header connection, or its first access token. */
function SecretForm({
	connection,
	podId,
	done,
}: {
	connection: Connection;
	podId: string;
	done: () => void;
}) {
	const actions = useConnectionActions(podId);
	const [secret, setSecret] = useState("");
	const needsToken = connection.secretHeader === null;

	async function save(event: FormEvent) {
		event.preventDefault();
		if (!secret) return;
		try {
			await actions.update.mutateAsync({
				connectionId: connection.id,
				json: needsToken
					? { secretHeader: "Authorization", secret: bearerAuthorization(secret) }
					: { secret },
			});
		} catch {
			return;
		}
		done();
	}

	return (
		<SettingsGroup
			label={secretActionLabel(connection)}
			note={
				needsToken
					? "Sent as Authorization: Bearer, followed by the token."
					: `Sent in the ${connection.secretHeader} header.`
			}
		>
			<form onSubmit={save} className="flex items-center gap-3 px-4 py-2.5">
				<input
					aria-label={`${connection.name} secret`}
					type="password"
					autoComplete="off"
					// biome-ignore lint/a11y/noAutofocus: opened by asking to change it, so typing is next.
					autoFocus
					value={secret}
					onChange={(event) => setSecret(event.target.value)}
					placeholder={needsToken ? "Paste the access token" : "Paste the new secret"}
					className="min-w-0 flex-1 bg-transparent font-mono text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
				/>
				<Button type="button" size="sm" variant="ghost" onClick={done}>
					Cancel
				</Button>
				<Button type="submit" size="sm" disabled={!secret || actions.update.isPending}>
					Save
				</Button>
			</form>
		</SettingsGroup>
	);
}

/**
 * The connection's tools that only read, then those that may make changes,
 * each with the setting its tools share, leaving out an empty one.
 */
function toolGroups(
	tools: ConnectionToolWithAccess[],
): { label: string; tools: ConnectionToolWithAccess[]; setting: AccessSetting }[] {
	return [
		{ label: "Reading", tools: tools.filter((tool) => !connectionToolMutating(tool)) },
		{ label: "Making changes", tools: tools.filter(connectionToolMutating) },
	].flatMap((group) => {
		const setting = accessSettingOf(group.tools);
		return setting ? [{ ...group, setting }] : [];
	});
}

/**
 * One group of tools, open to start with: its name and how many, a menu that
 * sets all of them and reads Custom while they differ, and each of `shown`
 * with its own setting. Choosing Custom opens the group.
 */
function ToolGroup({
	label,
	tools,
	setting,
	shown,
	canManage,
	setToolAccess,
}: {
	label: string;
	/** Every tool in the group, which its menu sets. */
	tools: ConnectionToolWithAccess[];
	/** What `tools` share, which its menu reads. */
	setting: AccessSetting;
	/** The ones the search leaves. */
	shown: ConnectionToolWithAccess[];
	canManage: boolean;
	setToolAccess: (toolAccess: Record<string, ConnectionAccess>) => void;
}) {
	const [open, setOpen] = useState(true);
	const listId = useId();
	if (shown.length === 0) return null;
	return (
		<section aria-label={label} className="flex flex-col gap-2">
			<div className="flex items-center gap-2 pl-1">
				<button
					type="button"
					aria-expanded={open}
					aria-controls={listId}
					aria-label={`${label}, ${tools.length} ${tools.length === 1 ? "tool" : "tools"}`}
					onClick={() => setOpen(!open)}
					className="focus-ring flex min-w-0 items-center gap-1.5 rounded-md text-left"
				>
					<ChevronDown
						aria-hidden
						size={16}
						className={cn(
							"shrink-0 text-subtle-foreground transition-transform",
							!open && "-rotate-90",
						)}
					/>
					<span className="font-medium text-[14.5px] text-foreground">{label}</span>
					<span className="rounded-md bg-chip px-1.5 py-px font-medium text-muted-foreground text-xs">
						{tools.length}
					</span>
				</button>
				{canManage ? (
					<AccessMenu
						label={`${label} tools`}
						value={setting}
						onChange={(access) =>
							setToolAccess(Object.fromEntries(tools.map((tool) => [tool.name, access])))
						}
						onCustom={() => setOpen(true)}
						className="ml-auto"
					/>
				) : (
					<AccessValue value={setting} className="ml-auto" />
				)}
			</div>
			{open && (
				<div id={listId} className="overflow-hidden rounded-panel bg-list">
					{shown.map((tool) => {
						const name = wordsFromKey(tool.name);
						return (
							<div
								key={tool.name}
								className="flex min-h-[52px] items-center gap-3 border-border border-b px-4 py-2 last:border-b-0"
							>
								{/* A tool that is off fades to a quieter colour, not by opacity, which would take its name below a readable contrast. */}
								<span
									className={cn(
										"min-w-0 flex-1 truncate text-[14.5px] transition-colors duration-150",
										tool.access === "off" ? "text-muted-foreground" : "text-foreground",
									)}
								>
									{name}
								</span>
								<AccessToggle
									label={name}
									value={tool.access}
									canManage={canManage}
									onChange={(access) => setToolAccess({ [tool.name]: access })}
								/>
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}
