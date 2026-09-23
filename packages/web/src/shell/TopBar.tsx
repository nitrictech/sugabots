import { Link, useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, Settings } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useWorkspace, useWorkspaces } from "@/lib/workspace.ts";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuLinkItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";

export function TopBar({ navigation }: { navigation: ReactNode }) {
	return (
		<header className="flex h-topbar shrink-0 items-center gap-3 px-3 md:px-5">
			{navigation}
			<WorkspaceMenu />
		</header>
	);
}

/**
 * The workspace, and the way to another one.
 *
 * A menu even when there is only one, because "which workspace am I in" is
 * worth being able to check, and a control that appears once somebody joins a
 * second workspace is a control nobody knows about.
 */
function WorkspaceMenu() {
	const { data: workspaces } = useWorkspaces();
	const { workspace } = useWorkspace();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger className="focus-ring flex min-w-0 cursor-pointer items-center gap-3 rounded-lg py-1 pr-2 hover:bg-sidebar-accent">
				<WorkspaceMark name={workspace?.name} />
				<span className="min-w-0 max-w-[40vw] truncate font-bold text-heading text-lg md:max-w-80">
					{workspace?.name ?? "Workspace"}
				</span>
				<ChevronDown size={15} strokeWidth={2.2} className="shrink-0 text-muted-foreground" />
			</DropdownMenuTrigger>

			<DropdownMenuContent align="start" className="min-w-56">
				<DropdownMenuGroup>
					<DropdownMenuLabel className="text-subtle-foreground">Workspaces</DropdownMenuLabel>
					{workspaces?.map((one) => (
						<DropdownMenuItem
							key={one.id}
							onClick={() => {
								// The pods and agents in the address belong to the
								// workspace being left, so landing goes back to picking.
								void navigate({
									to: "/$workspace/agents",
									params: { workspace: one.slug },
									replace: true,
								});
							}}
						>
							<WorkspaceMark name={one.name} size={18} />
							<span className="min-w-0 flex-1 truncate">{one.name}</span>
							{one.id === workspace?.id && <Check className="shrink-0" />}
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuLinkItem
					render={<Link from="/$workspace" to="./settings" />}
					onClick={() => setOpen(false)}
				>
					<Settings />
					Workspace settings
				</DropdownMenuLinkItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function WorkspaceMark({ name, size = 28 }: { name?: string; size?: number }) {
	return (
		<span
			aria-hidden
			className="grid shrink-0 place-items-center rounded-md bg-heading font-bold text-card"
			style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}
		>
			{(name ?? "?").trim().slice(0, 1).toUpperCase()}
		</span>
	);
}
