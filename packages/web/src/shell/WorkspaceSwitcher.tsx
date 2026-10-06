import type { Workspace } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { Check, Plus, Settings } from "lucide-react";
import type { useBackToHere } from "@/lib/settings-back.tsx";
import { chooseWorkspace } from "@/lib/workspace.ts";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";

/**
 * The tile at the top of the rail naming the workspace being looked at. Its
 * menu opens any other one this person belongs to, sets up a new one, and opens
 * the workspace's settings.
 *
 * Choosing one goes to its address, which is what decides the workspace under
 * `/$workspace`; `chooseWorkspace` also makes it the one `/` opens next time.
 */
export function WorkspaceSwitcher({
	current,
	workspaces,
	settingsBack,
}: {
	current: Workspace;
	/** Every workspace this person belongs to, `current` among them. */
	workspaces: readonly Workspace[];
	/** History state for the settings link, so its Back returns to the page it left. */
	settingsBack?: ReturnType<typeof useBackToHere>;
}) {
	return (
		<DropdownMenu>
			<Tooltip label={current.name} side="right">
				<DropdownMenuTrigger
					aria-label={`Workspace: ${current.name}`}
					className="focus-ring grid size-11 shrink-0 place-items-center rounded-tile bg-foreground font-semibold text-background text-lg transition-opacity hover:opacity-90"
				>
					<WorkspaceInitial workspace={current} />
				</DropdownMenuTrigger>
			</Tooltip>
			<DropdownMenuContent side="right" align="start" className="min-w-56 max-w-72">
				{workspaces.map((workspace) =>
					workspace.id === current.id ? (
						<DropdownMenuItem key={workspace.id} aria-current="page">
							<WorkspaceRow workspace={workspace} />
							<Check className="text-soft-foreground" />
						</DropdownMenuItem>
					) : (
						<DropdownMenuItem
							key={workspace.id}
							render={
								<Link
									to="/$workspace/agents"
									params={{ workspace: workspace.slug }}
									onClick={() => chooseWorkspace(workspace.id)}
								/>
							}
						>
							<WorkspaceRow workspace={workspace} />
						</DropdownMenuItem>
					),
				)}
				<DropdownMenuItem render={<Link to="/onboarding" />}>
					<Plus />
					New workspace
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					render={
						<Link
							to="/$workspace/settings"
							params={{ workspace: current.slug }}
							state={settingsBack}
						/>
					}
				>
					<Settings />
					Workspace settings
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function WorkspaceRow({ workspace }: { workspace: Workspace }) {
	return (
		<>
			<span
				aria-hidden
				className="grid size-6 shrink-0 place-items-center rounded-md bg-tile font-semibold text-soft-foreground text-xs"
			>
				<WorkspaceInitial workspace={workspace} />
			</span>
			<span className="min-w-0 flex-1 truncate">{workspace.name}</span>
		</>
	);
}

function WorkspaceInitial({ workspace }: { workspace: Workspace }) {
	return <span aria-hidden>{Array.from(workspace.name.trim())[0]?.toUpperCase() ?? "?"}</span>;
}
