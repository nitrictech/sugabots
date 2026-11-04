# Sugabots API for Android

The API's types and routes in Kotlin, package `ai.sugabots.api`, for the Android
app to depend on once there is one. It needs only kotlinx.serialization and
kotlinx.coroutines.

- `Api.generated.kt` is generated from `packages/contracts/openapi.json`. Don't
  edit it by hand; from the repo root, regenerate it, with the iOS app's
  generated files, after the API changes:

  ```sh
  node apps/ios/scripts/generate.ts
  ```

  The `ios` tests (`bunx vitest run --project ios`) fail while it is out of date.
  The generator is `apps/ios/scripts/generate-api.ts`: `api/model.ts` reads the
  API, and `api/kotlin.ts` writes this file.
- `ApiSupport.kt` is what it's written against: `ApiTransport`, which the app
  implements over OkHttp or Ktor to send requests with the API's address and the
  bearer token; `ApiJson`; `Omittable`, for a field a request may leave out or
  send as null; and the serializers that read enums and unions a newer server
  sends.

`ApiClient(transport)` groups the routes as the web's client does:
`api.threads.get(...)` there is `client.threads.get(...)` here.

Build and test it with Gradle (JDK 17):

```sh
gradle -p apps/android/api build
```
