import type { Workspace } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { Check, LogOut, Plus, UserPlus, UserRound } from "lucide-react";
import type { useBackToHere } from "@/lib/settings-back.tsx";
import { chooseWorkspace } from "@/lib/workspace.ts";
import { PersonAvatar } from "@/ui/avatar.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";

/**
 * You, at the foot of the sidebar. The menu names you, leads to your
 * preferences and signs you out, and its workspace item opens the workspace's
 * own menu: inviting people, and any other workspace you belong to, or a new
 * one. The workspace's settings are in the sidebar.
 *
 * Choosing a workspace goes to its address, which is what decides the
 * workspace under `/$workspace`; `chooseWorkspace` also makes it the one `/`
 * opens next time.
 */
export function AccountMenu({
	user,
	current,
	workspaces,
	settingsBack,
	onSignOut,
}: {
	user: { name: string; email: string; image?: string | null };
	current: Workspace;
	/** Every workspace you belong to, `current` among them. */
	workspaces: readonly Workspace[];
	/** History state for the settings links, so their Back returns to the page they left. */
	settingsBack?: ReturnType<typeof useBackToHere>;
	onSignOut: () => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`Account: ${user.name}`}
				className="focus-ring flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 text-left transition-colors hover:bg-row-hover data-popup-open:bg-row-selected"
			>
				<PersonAvatar person={user} size={24} />
				<span className="min-w-0 flex-1 truncate text-[13px] text-soft-foreground">
					{user.name}
				</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent side="top" align="start" className="w-[232px]">
				<div className="flex items-center gap-2.5 p-2">
					<PersonAvatar person={user} size={32} />
					<span className="flex min-w-0 flex-1 flex-col leading-snug">
						<span className="truncate font-medium text-[14px] text-foreground">{user.name}</span>
						<span className="truncate text-[12px] text-subtle-foreground">{user.email}</span>
					</span>
				</div>
				<DropdownMenuSeparator />
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<WorkspaceRow workspace={current} />
					</DropdownMenuSubTrigger>
					<DropdownMenuContent side="right" align="end" className="w-[232px]">
						<DropdownMenuItem
							render={
								<Link
									to="/$workspace/settings/$section"
									params={{ workspace: current.slug, section: "members" }}
									state={settingsBack}
								/>
							}
						>
							<UserPlus />
							Invite people
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						{workspaces.map((workspace) =>
							workspace.id === current.id ? (
								<DropdownMenuItem key={workspace.id} aria-current="page">
									<WorkspaceRow workspace={workspace} />
									<Check className="text-foreground" />
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
					</DropdownMenuContent>
				</DropdownMenuSub>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					render={
						<Link
							to="/$workspace/settings/$section"
							params={{ workspace: current.slug, section: "profile" }}
							state={settingsBack}
						/>
					}
				>
					<UserRound />
					Preferences
				</DropdownMenuItem>
				<DropdownMenuItem onClick={onSignOut}>
					<LogOut />
					Sign out
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
				className="grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-tile font-semibold text-[10px] text-foreground"
			>
				{Array.from(workspace.name.trim())[0]?.toUpperCase() ?? "?"}
			</span>
			<span className="min-w-0 flex-1 truncate">{workspace.name}</span>
		</>
	);
}
