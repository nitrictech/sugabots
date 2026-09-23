import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Otlp, OtlpSerialization } from "effect/unstable/observability";
import { VERSION } from "./version.ts";

/**
 * Exports the process's traces and Effect logs over OTLP/HTTP, configured by
 * the standard `OTEL_*` variables (`OTEL_EXPORTER_OTLP_ENDPOINT`,
 * `OTEL_TRACES_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_HEADERS`,
 * `OTEL_RESOURCE_ATTRIBUTES`), read from the runtime's `ConfigProvider`: the
 * process environment unless one is provided above this layer. Without an
 * endpoint it exports nothing, and spans cost only their creation.
 */
export const observabilityLayer = Otlp.layerFromConfig({
	resource: { serviceName: "sugabots", serviceVersion: VERSION },
}).pipe(Layer.provide([FetchHttpClient.layer, OtlpSerialization.layerJson]));
