import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDown } from "lucide-react";
import { client } from "@/api.ts";
import type { Session } from "@/lib/session.ts";
import { type Theme, useTheme } from "@/lib/theme.ts";
import { PersonAvatar } from "@/ui/avatar.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";

const themes: { value: Theme; label: string }[] = [
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
	{ value: "system", label: "Follow the system" },
];

/**
 * You, at the foot of the sidebar: who you are signed in as, and the menu that
 * changes the theme or signs you out.
 *
 * It sits opposite the workspace in the top bar — the workspace above, the
 * person below — rather than beside it, where two identities competed at the
 * same altitude. The trigger names the account rather than only picturing it,
 * so the answer to "which account is this" needs no click, which is why the
 * menu itself no longer repeats the name and address.
 *
 * One of these is on screen at a time: the sidebar is a drawer on a narrow
 * viewport, so this travels into the drawer instead of being duplicated.
 */
export function AccountMenu({ session }: { session: Session }) {
	const [theme, setTheme] = useTheme();
	const navigate = useNavigate();
	const user = session.user;

	async function signOut() {
		await client.auth.signOut();
		await session.refresh();
		await navigate({ to: "/login", replace: true });
	}

	return (
		<div className="shrink-0 border-sidebar-border border-t pt-2">
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label={user ? `${user.name} and settings` : "Account"}
					className="focus-ring flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-sidebar-accent motion-reduce:transition-none"
				>
					<PersonAvatar name={user?.name ?? "?"} image={user?.image} size={34} />
					<span className="min-w-0 flex-1">
						<span className="block truncate font-semibold text-base text-heading">
							{user?.name ?? "Account"}
						</span>
						{user?.email && (
							<span className="block truncate font-mono text-subtle-foreground text-xs">
								{user.email}
							</span>
						)}
					</span>
					<ChevronsUpDown size={15} className="shrink-0 text-muted-foreground" />
				</DropdownMenuTrigger>

				<DropdownMenuContent align="start" side="top" className="min-w-56">
					<DropdownMenuRadioGroup value={theme} onValueChange={(next) => setTheme(next as Theme)}>
						<DropdownMenuLabel className="text-subtle-foreground">Theme</DropdownMenuLabel>
						{themes.map((option) => (
							<DropdownMenuRadioItem key={option.value} value={option.value}>
								{option.label}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => void signOut()}>Sign out</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
