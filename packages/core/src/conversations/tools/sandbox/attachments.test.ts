import { describe, expect, it } from "vitest";
import { sandboxPathOf } from "./attachments.ts";

const ID = "0199a3a0-0000-7000-8000-0000000000f1";
const pathOf = (name: string) => sandboxPathOf({ id: ID, name });

describe("where an attachment is copied in the sandbox", () => {
	it("keeps an ordinary name as it is, in a folder of the file's own", () => {
		expect(pathOf("Q3 report (final).pdf")).toBe(`attachments/${ID}/Q3 report (final).pdf`);
		expect(pathOf("café menu.csv")).toBe(`attachments/${ID}/café menu.csv`);
	});

	it("keeps the name one file in its folder, however it was written", () => {
		expect(pathOf("../../etc/passwd")).toBe(`attachments/${ID}/_.._etc_passwd`);
		expect(pathOf("C:\\Users\\sam\\notes.txt")).toBe(`attachments/${ID}/C:_Users_sam_notes.txt`);
		expect(pathOf("..")).toBe(`attachments/${ID}/file`);
	});

	it("never makes a hidden file, or one a command reads as an option", () => {
		expect(pathOf(".env")).toBe(`attachments/${ID}/env`);
		expect(pathOf("-rf")).toBe(`attachments/${ID}/rf`);
	});

	it("leaves out characters that break a line or reorder how the name shows", () => {
		// A right-to-left override shows "invoice‮fdp.exe" as "invoiceexe.pdf".
		expect(pathOf("invoice\u202Efdp.exe")).toBe(`attachments/${ID}/invoicefdp.exe`);
		expect(pathOf("a\u007Fb.txt")).toBe(`attachments/${ID}/a_b.txt`);
	});

	it("cuts a long name to what Linux allows, in bytes, keeping its extension", () => {
		const name = `${"é".repeat(300)}.pdf`;
		const kept = pathOf(name).split("/").at(-1) ?? "";

		expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(255);
		expect(kept.endsWith("é.pdf")).toBe(true);
	});
});
