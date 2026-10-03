import {
	type Connection,
	type ConnectionTool,
	connectionPresetFor,
	type Pod,
} from "@sugabots/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { type FormEvent, type ReactNode, useDeferredValue, useState } from "react";
import { bearerAuthorization, useConnectionActions } from "@/lib/connections.ts";
import { failureMessage } from "@/lib/failure.ts";
import { podSettingsLink } from "@/lib/links.ts";
import { wordsFromKey } from "@/lib/tool-names.ts";
import { Alert, Success } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { ConnectionMark } from "@/ui/connection-mark.tsx";
import { DeleteDialog } from "@/ui/delete-dialog.tsx";
import { SettingsDanger, SettingsGroup, SettingsPage, SettingsRow } from "@/ui/settings-page.tsx";
import { ConnectionRow, valueText } from "./connection-row.tsx";

/*
 * One connection, on a page of its own under its pod: where it is and how it
 * signs in, a check that it answers, what its tools do under its access, and
 * removing it.
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
		tool.description?.toLowerCase().includes(needle);

	async function remove() {
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
				<div className="flex min-w-0 flex-col gap-0.5">
					<h2 className="m-0 truncate font-bold text-[22px] text-foreground tracking-[-0.01em]">
						{connection.name}
					</h2>
					<p className="m-0 truncate text-[13px] text-muted-foreground">{pod.name} pod</p>
				</div>
			</div>
			<div className="flex flex-col gap-3">
				<SettingsGroup label="Connection">
					{/* A catalog app is known by its name; only a server added by URL is told apart by it. */}
					{!preset && (
						<ConnectionRow label="Address">
							<span className={valueText}>{connection.url}</span>
						</ConnectionRow>
					)}
					{connection.auth === "oauth" ? (
						<SettingsRow
							label="Sign-in"
							sub={connection.signedIn ? "Signed in" : "Not signed in yet"}
							trailing={
								canManage && (
									<Button
										size="sm"
										variant="secondary"
										disabled={actions.signIn.isPending}
										onClick={() => actions.signIn.mutate({ connectionId: connection.id })}
									>
										{connection.signedIn ? "Sign in again" : "Sign in"}
									</Button>
								)
							}
						/>
					) : (
						<SecretRows connection={connection} podId={pod.id} canManage={canManage} />
					)}
					<SettingsRow
						label="Check connection"
						sub="Make sure Sugabots can reach the server."
						trailing={
							<Button
								size="sm"
								variant="secondary"
								disabled={actions.test.isPending}
								onClick={() => actions.test.mutate({ connectionId: connection.id })}
							>
								{actions.test.isPending ? "Checking…" : "Check"}
							</Button>
						}
					/>
				</SettingsGroup>
				{failure && (
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
				{checked?.reachable && <Success>Connection successful</Success>}
				{error && <Alert>{failureMessage(error)}</Alert>}
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
			{connection.tools.length === 0 ? (
				<SettingsGroup label="Tools">
					<SettingsRow label="No actions found yet." />
				</SettingsGroup>
			) : (
				toolGroups(connection)
					.map((group) => ({ ...group, tools: group.tools.filter(matches) }))
					.filter((group) => group.tools.length > 0)
					.map((group) => (
						<SettingsGroup key={group.label} label={group.label} note={group.note}>
							{group.tools.map((tool) => (
								<ConnectionToolRow key={tool.name} tool={tool} />
							))}
						</SettingsGroup>
					))
			)}
			{canManage && (
				<SettingsDanger onClick={() => setRemoving(true)}>Remove connection</SettingsDanger>
			)}
			<DeleteDialog
				open={removing}
				onOpenChange={setRemoving}
				title={`Remove ${connection.name}?`}
				description="Bots in this pod can no longer use its tools. Adding it again means signing in or entering its details again."
				confirmLabel="Remove"
				pending={actions.remove.isPending}
				error={actions.remove.error ? failureMessage(actions.remove.error) : undefined}
				onDelete={remove}
			/>
		</SettingsPage>
	);
}

/** The secret a header connection sends, and replacing it. */
function SecretRows({
	connection,
	podId,
	canManage,
}: {
	connection: Connection;
	podId: string;
	canManage: boolean;
}) {
	const actions = useConnectionActions(podId);
	const [replacing, setReplacing] = useState(false);
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
		setSecret("");
		setReplacing(false);
	}

	return (
		<>
			<SettingsRow
				label={needsToken ? "Access token" : "Secret"}
				sub={needsToken ? "None yet" : `Sent as ${connection.secretHeader}`}
				trailing={
					canManage && (
						<Button size="sm" variant="secondary" onClick={() => setReplacing(!replacing)}>
							{connection.hasSecret ? "Replace" : "Add"}
						</Button>
					)
				}
			/>
			{replacing && (
				<form
					onSubmit={save}
					className="flex items-center gap-3 border-border border-b px-4 py-2.5 last:border-b-0"
				>
					<input
						aria-label={`${connection.name} secret`}
						type="password"
						autoComplete="off"
						value={secret}
						onChange={(event) => setSecret(event.target.value)}
						placeholder={needsToken ? "Paste the access token" : "Paste the new secret"}
						className="min-w-0 flex-1 bg-transparent font-mono text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
					/>
					<Button type="submit" size="sm" disabled={!secret || actions.update.isPending}>
						Save
					</Button>
				</form>
			)}
		</>
	);
}

/** How a tool runs under the connection's access: straight away, after a yes, or not at all. */
function toolGroups(
	connection: Connection,
): { label: string; note?: string; tools: ConnectionTool[] }[] {
	const tools = connection.tools;
	if (connection.access === "off") {
		return [{ label: "Tools", note: "Off, so bots in this pod can't use these.", tools }];
	}
	return [{ label: connection.access === "ask" ? "Asks first" : "Runs freely", tools }];
}

/**
 * One of a connection's tools: its name in words, and what it does, unless
 * the description only says the name again.
 */
export function ConnectionToolRow({ tool }: { tool: ConnectionTool }) {
	const label = wordsFromKey(tool.name);
	const description = tool.description?.trim();
	const says = description && description.toLowerCase() !== label.toLowerCase();
	return <SettingsRow label={label} sub={says ? description : undefined} />;
}
