import { describe, expect, it } from "vitest";
import { parseProviderBaseUrl } from "@/lib/provider-url.ts";

describe("provider base URLs", () => {
	it.each([
		["a bare host and port", "192.168.1.10:11434", "http://192.168.1.10:11434/v1"],
		["a host alone", "ollama.lan", "http://ollama.lan/v1"],
		["surrounding space", "  127.0.0.1:11434  ", "http://127.0.0.1:11434/v1"],
		["a trailing slash", "http://127.0.0.1:11434/v1/", "http://127.0.0.1:11434/v1"],
		["a path of its own", "https://gateway.example/ollama", "https://gateway.example/ollama"],
	])("completes %s into a base URL", (_label, typed, expected) => {
		expect(parseProviderBaseUrl(typed)).toBe(expected);
	});

	it.each([
		["nothing", ""],
		["only space", "   "],
		["words", "my ollama server"],
		["a scheme alone", "http://"],
		["a scheme we cannot call", "ftp://models.example"],
		["credentials", "https://user:secret@models.example/v1"],
		["a fragment", "https://models.example/v1#internal"],
	])("reads %s as no base URL at all", (_label, typed) => {
		expect(parseProviderBaseUrl(typed)).toBeUndefined();
	});
});
