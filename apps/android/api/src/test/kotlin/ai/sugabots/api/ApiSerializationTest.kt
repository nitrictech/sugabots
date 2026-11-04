package ai.sugabots.api

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class ApiSerializationTest {
    private val json = ApiJson

    @Test
    fun `an enum reads a value it doesn't know as unknown, and won't send it`() {
        assertEquals(AgentColor.RED, json.decodeFromString<AgentColor>("\"red\""))
        assertEquals(AgentColor.UNKNOWN, json.decodeFromString<AgentColor>("\"chartreuse\""))
        assertEquals("\"red\"", json.encodeToString(AgentColor.RED))
        assertFailsWith<SerializationException> { json.encodeToString(AgentColor.UNKNOWN) }
    }

    @Test
    fun `a tagged union reads a tag it doesn't know as unknown, and its members by their tag`() {
        val schedule = json.decodeFromString<RoutineSchedule>(
            """{"repeat":"monthly","every":1,"dayOfMonth":"last","times":[540],"startsOn":"2026-11-01","extra":true}""",
        )
        assertEquals(
            RoutineSchedule.Monthly(every = 1, dayOfMonth = RoutineSchedule.Monthly.DayOfMonth.Last, times = listOf(540), startsOn = "2026-11-01"),
            schedule,
        )
        assertEquals(RoutineSchedule.Unknown("fortnightly"), json.decodeFromString<RoutineSchedule>("""{"repeat":"fortnightly"}"""))
        assertFailsWith<SerializationException> { json.encodeToString<RoutineSchedule>(RoutineSchedule.Unknown("fortnightly")) }
    }

    @Test
    fun `a member's tag is sent though it's the default`() {
        val sent = json.parseToJsonElement(json.encodeToString<RoutineSchedule>(RoutineSchedule.Cron(expression = "0 9 * * 1")))
        assertEquals(JsonObject(mapOf("repeat" to JsonPrimitive("cron"), "expression" to JsonPrimitive("0 9 * * 1"))), sent)
    }

    @Test
    fun `an untagged union tries each member`() {
        val day = { text: String -> json.decodeFromString<RoutineSchedule.Monthly.DayOfMonth>(text) }
        assertEquals(RoutineSchedule.Monthly.DayOfMonth.Last, day("\"last\""))
        assertEquals(RoutineSchedule.Monthly.DayOfMonth.Integer(15), day("15"))
        assertFailsWith<SerializationException> { day("\"first\"") }
        assertEquals("15", json.encodeToString<RoutineSchedule.Monthly.DayOfMonth>(RoutineSchedule.Monthly.DayOfMonth.Integer(15)))
    }

    @Test
    fun `a clearable field is left out to keep its value, and sent as null to clear it`() {
        assertEquals("{}", json.encodeToString(PodUpdate()))
        assertEquals("""{"name":"Ops","slug":null}""", json.encodeToString(PodUpdate(name = "Ops", slug = Omittable.Present(null))))
        assertEquals("""{"color":"green"}""", json.encodeToString(PodUpdate(color = Omittable.Present(PodColor.GREEN))))

        assertEquals(PodUpdate(), json.decodeFromString<PodUpdate>("{}"))
        assertEquals(PodUpdate(slug = Omittable.Present(null)), json.decodeFromString<PodUpdate>("""{"slug":null}"""))
    }

    @Test
    fun `a required field that may be null is sent as null, and read as null when left out`() {
        assertEquals("""{"items":[],"nextCursor":null}""", json.encodeToString(ChatMessagesPage(items = emptyList())))
        assertEquals(ChatMessagesPage(items = emptyList()), json.decodeFromString<ChatMessagesPage>("""{"items":[]}"""))
    }

    /** Stops a request once the transport has it, to look at what was sent. */
    private class Sent(val request: ApiRequest) : Exception()

    private val recordingClient = ApiClient({ request -> throw Sent(request) })

    @Test
    fun `a route sends its body's fields, and its path's values escaped`() = runTest {
        val request = assertFailsWith<Sent> {
            recordingClient.pods.update("pod 1", name = "Ops", slug = Omittable.Present(null))
        }.request
        assertEquals("PATCH", request.method)
        assertEquals("pods/pod%201", request.path)
        assertEquals("""{"name":"Ops","slug":null}""", assertIs<ApiRequestBody.Json>(request.body).text)
    }

    @Test
    fun `a route sends the query parameters it's given, and leaves out the rest`() = runTest {
        val request = assertFailsWith<Sent> { recordingClient.chats.messages("c1", limit = "20") }.request
        assertEquals("conversations/c1/messages", request.path)
        assertEquals(listOf("limit" to "20"), request.query)
    }

    @Test
    fun `a failure is thrown in the API's words`() = runTest {
        val client = ApiClient({ ApiResponse(404, """{"_tag":"NotFound","message":"No such pod."}""".encodeToByteArray()) })
        val failure = assertFailsWith<ApiFailure> { client.pods.remove("pod-1") }
        assertEquals(404, failure.status)
        assertEquals("No such pod.", failure.message)
    }
}
