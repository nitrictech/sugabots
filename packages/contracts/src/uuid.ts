import { Schema, SchemaGetter, SchemaTransformation } from "effect";

/**
 * A UUID, decoded to lowercase. Postgres compares UUIDs whatever their case,
 * but keys built from an id (blob keys, stream names, lock keys) don't, so
 * every id past a contract is in one spelling.
 */
export const uuidSchema = Schema.String.check(Schema.isUUID()).pipe(
	Schema.decode(SchemaTransformation.toLowerCase()),
);

const isUuid = Schema.is(Schema.String.check(Schema.isGUID()));

/**
 * A reference to something by id that may not be well formed: a UUID is
 * lowercased as by `uuidSchema`, and any other string passes through, so the
 * operation answers it as it answers an id nobody can reach (`ResourceHidden`)
 * rather than as a malformed request. Also used where a slug or an id may come.
 */
export const uuidOrStringSchema = Schema.String.pipe(
	Schema.decode({
		decode: SchemaGetter.transform((value) => (isUuid(value) ? value.toLowerCase() : value)),
		encode: SchemaGetter.passthrough(),
	}),
);
