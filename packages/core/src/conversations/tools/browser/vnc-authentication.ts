/// <reference path="./des.d.ts" />
import des from "des.js";

/** How many bytes of a password VNC authentication uses; the rest are ignored. */
export const PASSWORD_BYTES = 8;

/** The size of the challenge a VNC server sends, and of the answer. */
export const CHALLENGE_BYTES = 16;

/**
 * VNC authentication's answer to a server's challenge: the challenge
 * encrypted with DES under the password (RFC 6143, 7.2.2). VNC servers read
 * each key byte with its bits in reverse order, so the key is written that way.
 */
export function answerChallenge(password: string, challenge: Uint8Array): Uint8Array {
	const key = new Uint8Array(PASSWORD_BYTES);
	key.set(new TextEncoder().encode(password).subarray(0, PASSWORD_BYTES));
	const cipher = des.DES.create({ type: "encrypt", key: key.map(reverseBits), padding: false });
	return Uint8Array.from([...cipher.update(challenge), ...cipher.final()]);
}

function reverseBits(byte: number) {
	let reversed = 0;
	for (let bit = 0; bit < 8; bit++) reversed |= ((byte >> bit) & 1) << (7 - bit);
	return reversed;
}
