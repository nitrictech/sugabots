export function hueFromText(text: string): number {
	let hue = 0;
	for (const character of text) {
		hue = (hue * 31 + (character.codePointAt(0) ?? 0)) % 360;
	}
	return hue;
}
