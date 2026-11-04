// What `Api.generated.kt` is written against: how a request is sent, and how
// the API's JSON is read and written.

package ai.sugabots.api

import java.net.URLEncoder
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.modules.SerializersModule

// MARK: Sending requests

/** A request to the API. `path` is relative to the API's mount, such as `workspaces/acme/chats`. */
class ApiRequest(
    val method: String,
    val path: String,
    val query: List<Pair<String, String>>,
    val body: ApiRequestBody?,
)

/** What a request sends: JSON, or bytes as they are, as an upload. */
sealed interface ApiRequestBody {
    val contentType: String

    class Json(val text: String) : ApiRequestBody {
        override val contentType: String get() = "application/json"
    }

    class Bytes(val bytes: ByteArray) : ApiRequestBody {
        override val contentType: String get() = "application/octet-stream"
    }
}

/** What the API answered, whatever its status. */
class ApiResponse(val status: Int, val body: ByteArray)

/**
 * Sends requests to the API over HTTP. An implementation, over OkHttp or Ktor,
 * resolves a request's path against the API's address
 * (`https://sugabots.example.com/api/`), adds the bearer token, and answers
 * with the response as it came, whatever its status.
 */
fun interface ApiTransport {
    suspend fun send(request: ApiRequest): ApiResponse
}

/** A refusal or failure the API answered with, in its own words. */
class ApiFailure(val status: Int, override val message: String) : Exception(message)

/** How the API's JSON is read and written: fields this app doesn't know are ignored, and a field left at its default is left out. */
val ApiJson: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = false
    serializersModule = SerializersModule { contextual(Instant::class, InstantSerializer) }
}

/** Sends the generated routes' requests through a transport, and reads their answers. */
open class ApiCaller(
    @PublishedApi internal val transport: ApiTransport,
    @PublishedApi internal val json: Json,
) {
    /** Sends a request and answers with its body as it came, or throws the API's failure. */
    suspend fun callForData(
        method: String,
        path: String,
        query: QueryItems = QueryItems(),
        body: ApiRequestBody? = null,
    ): ByteArray {
        val response = transport.send(ApiRequest(method, path, query.items, body))
        if (response.status !in 200..299) throw failure(response)
        return response.body
    }

    /** Sends a request and decodes its answer. */
    suspend inline fun <reified Response> call(
        method: String,
        path: String,
        query: QueryItems = QueryItems(),
        body: ApiRequestBody? = null,
    ): Response = json.decodeFromString<Response>(callForData(method, path, query, body).decodeToString())

    /** `body` as a request's JSON. */
    inline fun <reified Body> jsonBody(body: Body): ApiRequestBody =
        ApiRequestBody.Json(json.encodeToString(body))

    /** The API answers failures as `{ "_tag": "NotFound", "message": "…" }`. */
    private fun failure(response: ApiResponse): ApiFailure {
        val message = runCatching {
            (json.parseToJsonElement(response.body.decodeToString()) as? JsonObject)
                ?.get("message")
                ?.let { (it as? JsonPrimitive)?.contentOrNull }
        }.getOrNull()
        return ApiFailure(response.status, message ?: "The server answered ${response.status}.")
    }
}

/** A request's query, built a parameter at a time; one left out is not sent. */
class QueryItems {
    private val added = mutableListOf<Pair<String, String>>()
    val items: List<Pair<String, String>> get() = added.toList()

    fun add(name: String, value: String?) {
        if (value != null) added += name to value
    }

    /** Sends `name` once for each of `values`. */
    fun addAll(name: String, values: List<String>?) {
        values?.forEach { add(name, it) }
    }
}

/** `value` as one segment of a path, its reserved characters escaped. */
fun pathSegment(value: String): String = URLEncoder.encode(value, Charsets.UTF_8).replace("+", "%20")

// MARK: Reading and writing values

/** As the API writes a timestamp: `2026-10-30T09:00:00.000Z`. */
private val timestampFormat: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

fun formatTimestamp(instant: Instant): String = timestampFormat.format(instant)

/** Timestamps as the API writes them, read with or without their fraction of a second. */
object InstantSerializer : KSerializer<Instant> {
    override val descriptor = PrimitiveSerialDescriptor("ai.sugabots.api.Instant", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): Instant {
        val text = decoder.decodeString()
        return runCatching { Instant.parse(text) }.getOrElse {
            throw SerializationException("Not an ISO 8601 timestamp: $text")
        }
    }

    override fun serialize(encoder: Encoder, value: Instant) {
        encoder.encodeString(formatTimestamp(value))
    }
}

/** A number, which Effect writes as the string `Infinity`, `-Infinity` or `NaN` where JSON can't hold it. */
object NonFiniteDoubleSerializer : KSerializer<Double> {
    override val descriptor = PrimitiveSerialDescriptor("ai.sugabots.api.NonFiniteDouble", PrimitiveKind.DOUBLE)

    override fun deserialize(decoder: Decoder): Double {
        val element = (decoder as? JsonDecoder)?.decodeJsonElement() as? JsonPrimitive
            ?: return decoder.decodeDouble()
        if (!element.isString) return element.content.toDouble()
        return when (element.content) {
            "Infinity" -> Double.POSITIVE_INFINITY
            "-Infinity" -> Double.NEGATIVE_INFINITY
            "NaN" -> Double.NaN
            else -> throw SerializationException("Not a number: ${element.content}")
        }
    }

    override fun serialize(encoder: Encoder, value: Double) {
        when {
            value.isNaN() -> encoder.encodeString("NaN")
            value == Double.POSITIVE_INFINITY -> encoder.encodeString("Infinity")
            value == Double.NEGATIVE_INFINITY -> encoder.encodeString("-Infinity")
            else -> encoder.encodeDouble(value)
        }
    }
}

/**
 * A field a request may leave out, to keep what the server has, or send, even
 * as null, to change it: `Omitted`, or `Present(null)` to clear it. Its field
 * defaults to `Omitted`, which `ApiJson` leaves out as it does any default.
 */
@Serializable(with = OmittableSerializer::class)
sealed interface Omittable<out T> {
    data object Omitted : Omittable<Nothing>

    data class Present<out T>(val value: T) : Omittable<T>
}

class OmittableSerializer<T>(private val valueSerializer: KSerializer<T>) : KSerializer<Omittable<T>> {
    override val descriptor: SerialDescriptor = valueSerializer.descriptor

    /** A field that's there is present, even as null; one left out is never read, and keeps its default. */
    override fun deserialize(decoder: Decoder): Omittable<T> =
        Omittable.Present(valueSerializer.deserialize(decoder))

    override fun serialize(encoder: Encoder, value: Omittable<T>) {
        when (value) {
            is Omittable.Present -> valueSerializer.serialize(encoder, value.value)
            Omittable.Omitted -> throw SerializationException("An omitted field is left out, so ApiJson must not encode defaults.")
        }
    }
}

/** A string enum's value, as the API writes it. */
interface OpenEnum {
    val rawValue: String
}

/** A string enum that reads a value from a newer server than this app knows as `unknown`, which can't be sent. */
open class OpenEnumSerializer<E>(
    serialName: String,
    private val entries: List<E>,
    private val unknown: E,
) : KSerializer<E> where E : Enum<E>, E : OpenEnum {
    override val descriptor = PrimitiveSerialDescriptor(serialName, PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): E {
        val rawValue = decoder.decodeString()
        return entries.firstOrNull { it != unknown && it.rawValue == rawValue } ?: unknown
    }

    override fun serialize(encoder: Encoder, value: E) {
        if (value == unknown) throw SerializationException("A value this app doesn't know can't be sent.")
        encoder.encodeString(value.rawValue)
    }
}

/** A union, read and written as JSON by what its members' JSON holds. */
@OptIn(ExperimentalSerializationApi::class)
abstract class JsonUnionSerializer<T : Any>(serialName: String) : KSerializer<T> {
    final override val descriptor: SerialDescriptor =
        SerialDescriptor(serialName, JsonElement.serializer().descriptor)

    protected abstract fun decode(element: JsonElement, json: Json): T

    protected abstract fun encode(value: T, json: Json): JsonElement

    final override fun deserialize(decoder: Decoder): T {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("${descriptor.serialName} is read from JSON only.")
        return decode(input.decodeJsonElement(), input.json)
    }

    final override fun serialize(encoder: Encoder, value: T) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("${descriptor.serialName} is written as JSON only.")
        output.encodeJsonElement(encode(value, output.json))
    }

    /** The string an object's `property` holds, which tells a tagged union's members apart. */
    protected fun tagOf(element: JsonElement, property: String): String =
        ((element as? JsonObject)?.get(property) as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: throw SerializationException("${descriptor.serialName} has no `$property` to tell its kind by.")

    /** Whether `element` is exactly the string `value`. */
    protected fun JsonElement.isString(value: String): Boolean =
        this is JsonPrimitive && isString && content == value

    /** `element` as a `T`, or null when it isn't one, to try an untagged union's next member. */
    protected inline fun <reified T> Json.decodeOrNull(element: JsonElement): T? =
        try {
            decodeFromJsonElement<T>(element)
        } catch (_: IllegalArgumentException) {
            null
        }
}
