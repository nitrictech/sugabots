import { Schema } from "effect";

/**
 * The input schema for a tool that takes no arguments. An empty Struct
 * converts to "anything but null", which providers refuse as a tool's input;
 * a record of nothing converts to an empty object.
 */
export const noInputSchema = Schema.Record(Schema.String, Schema.Never).pipe(
	Schema.toStandardSchemaV1,
	Schema.toStandardJSONSchemaV1,
);
