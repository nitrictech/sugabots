import { SettingsRowIcon } from "@/ui/settings-page.tsx";

/** The first letter of `name` on a row's square, for what has no logo or face of its own. */
export function LetterTile({ name, className }: { name: string; className?: string }) {
	return (
		<SettingsRowIcon className={className}>{name.trim().charAt(0).toUpperCase()}</SettingsRowIcon>
	);
}
