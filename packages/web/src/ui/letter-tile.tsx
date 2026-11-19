import { SettingsRowIcon } from "@/ui/settings-page.tsx";

/**
 * The first letter of `name` on a row's square, for what has no logo or face
 * of its own.
 */
export function LetterTile({ name, className }: { name: string; className?: string }) {
	return <SettingsRowIcon className={className}>{initialOf(name)}</SettingsRowIcon>;
}

/**
 * The first letter of `name`, capitalised, as a tile shows it: a whole
 * character even outside the Basic Multilingual Plane, and "?" for an empty name.
 */
export function initialOf(name: string): string {
	return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
}
