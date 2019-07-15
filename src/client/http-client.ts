import { DfuseError, DfuseClientError, DfuseApiError } from "../types/error"
import {
  Fetch,
  HttpResponse,
  HttpQueryParameters,
  HttpClient,
  HttpHeaders
} from "../types/http-client"
import debugFactory, { IDebugger } from "debug"

/**
 * The set of options that can be used when constructing a the default
 * [[HttpClient]] instance through the [[createHttpClient]] factory
 * method.
 */
export interface HttpClientOptions {
  /**
   * The `fetch` function to use to make the actual low-level HTTP
   * request.
   *
   * **Inferrence**<br><br>
   * When not provided (default), the `fetch` to use is actually inferred
   * based on the runtime environment.
   *
   * If a `window.fetch` function exists, which should be the case on a Browser
   * environment, it will be used.
   *
   * If a `global.fetch` function exists, which can be the case upon a
   * `global.fetch = ...` call at the bootstrap phase in a Node.js environment,
   * it will be used
   *
   * Finally, if no `fetch` function could be determined, a [[DfuseError]] is
   * thrown with a message explaining the situtation and a link to the documentation
   * on how to solve the problem.
   *
   * @default `undefined` (Inferred based on environment, see `Inferrence` note above)
   */
  fetch?: Fetch
}

/**
 * Create the default [[HttpClient]] concrete implementation.
 *
 * @param authUrl The full dfuse Authentication url to use to perform the `authRequest` calls.
 * @param apiUrl The full dfuse REST API url to use to perform the `apiRequest` calls.
 * @param options The set of options used to construct the default [[HttpClient]] instance. See
 * [[HttpClientOptions]] for documentation of the options and default values for each of them.
 */
export function createHttpClient(
  authUrl: string,
  apiUrl: string,
  options: HttpClientOptions = {}
): HttpClient {
  return new DefaultHttpClient(authUrl, apiUrl, inferFetch(options.fetch))
}

function inferFetch(fetch?: Fetch): Fetch {
  const debug = debugFactory("dfuse:http")

  if (fetch !== undefined) {
    debug("Using user provided `fetch` option.")
    return fetch
  }

  // In both of the condition below to determine a global `fetch` to use,
  // we bind the `fetch` method to the global scope (either `window` or `global`
  // depending on the target environment).
  //
  // It happens in a bundler environment like WebPack that the `fetch` method
  // loses it's contextual `this` variable. The `this` is used internal by the
  // implementation for certain features of the specification.
  //
  // By doing a `.bind(<global scope>)`, we ensure the `fetch` remains bound
  // to the correct `this` variable.

  // If we are in a Browser environment and `fetch` is available, use it
  if (typeof window !== "undefined" && window.fetch != null) {
    debug("Using `fetch` global value found on 'window' variable (Browser environment).")
    return window.fetch.bind(window)
  }

  // If we are in a Node.js like environment and `fetch` is available, use it
  if (typeof global !== "undefined" && (global as any).fetch != null) {
    debug("Using `fetch` global value found on 'global' variable (Node.js environment).")
    return (global as any).fetch.bind(global)
  }

  // Otherwise, throw an exception
  const messages = [
    "You did not provide a `fetch` option and we were not able to infer one from the global scope.",
    "",
    "You are most likely in a Node.js environment where a global `fetch` is not available by defaut.",
    "To resolve the issue, either pass a compatible `fetch` option or globally defined a `global.fetch`",
    "variable pointing to a compatible `fetch` method.",
    "",
    "We invite you to read our documentation to learn more about this problem.",
    "",
    "See https://github.com/dfuse-io/client-js#nodejs"
  ]

  throw new DfuseClientError(messages.join("\n"))
}

/**
 * The `DefaultHttpClient` is responsible for performing the actual HTTP
 * calls, transforming the parameters into an actual HTTP request, and
 * turning the HTTP response back into a return value.
 *
 * All methods are asynchronous and return a response object when successful,
 * and throws a `DfuseError` when an error is encountered.
 */
class DefaultHttpClient {
  protected authUrl: string
  protected apiUrl: string
  protected fetch: Fetch

  private debug: IDebugger = debugFactory("dfuse:http")

  constructor(authUrl: string, apiUrl: string, fetch: Fetch) {
    this.authUrl = authUrl
    this.apiUrl = apiUrl
    this.fetch = fetch
  }

  public release(): void {
    return
  }

  public async authRequest<T>(
    path: string,
    method: string,
    params?: HttpQueryParameters,
    body?: any,
    headers?: HttpHeaders
  ): Promise<T> {
    return this.request<T>(undefined, this.authUrl + path, method, params, body, headers)
  }

  public async apiRequest<T>(
    apiToken: string,
    path: string,
    method: string,
    params?: HttpQueryParameters,
    body?: any,
    headers?: HttpHeaders
  ): Promise<T> {
    return this.request<T>(apiToken, this.apiUrl + path, method, params, body, headers)
  }

  private async request<T>(
    apiToken: string | undefined,
    url: string,
    method: string,
    params?: HttpQueryParameters,
    body?: any,
    headers?: HttpHeaders
  ): Promise<T> {
    this.debug("Preparing request [%s %s](%o)", method, url, params)

    if (params && Object.keys(params).length > 0) {
      url += "?" + this.queryParams(params)
    }

    const defaultHeaders: HttpHeaders = {}
    if (apiToken !== undefined) {
      defaultHeaders.Authorization = `Bearer ${apiToken}`
    }

    const userHeaders = headers || {}
    const mergedHeaders = { ...defaultHeaders, ...userHeaders }

    let jsonBody: string | undefined
    if (body !== undefined) {
      jsonBody = JSON.stringify(body)
    }

    try {
      this.debug(
        "Executing request [%s %s](headers: %o, bodyLength: %s)",
        method,
        url,
        mergedHeaders,
        (jsonBody || "").length
      )

      const response = await this.fetch(url, { headers: mergedHeaders, method, body: jsonBody })

      this.debug(
        "Received response [%s %s %s](headers: %o)",
        response.status,
        response.statusText,
        response.url,
        response.headers
      )

      if (!response.ok) {
        this.debug("Request returned with an error HTTP code %s", response.status)
        throw await this.bodyToApiError(response)
      }

      this.debug("Turning response body into response result")
      return await this.bodyToResponse<T>(response)
    } catch (error) {
      if (error instanceof DfuseError) {
        throw error
      }

      throw new DfuseClientError("Unable to perform HTTP request correctly", error)
    }
  }

  private async bodyToResponse<T>(response: HttpResponse): Promise<T> {
    try {
      return await response.json()
    } catch (error) {
      throw new DfuseClientError("The returned body shall have been a valid JSON object", error)
    }
  }

  private async bodyToApiError(response: HttpResponse): Promise<DfuseError> {
    const body = await response.text()

    try {
      return new DfuseApiError(JSON.parse(body))
    } catch (error) {
      return new DfuseClientError(
        `The returned body shall have been a valid JSON object, got '${body}'`,
        error
      )
    }
  }

  private queryParams(params: HttpQueryParameters) {
    const entries = []
    for (const key of Object.keys(params)) {
      const value = params[key]
      if (value !== undefined) {
        entries.push(encodeURIComponent(key) + "=" + encodeURIComponent(value))
      }
    }

    return entries.join("&")
  }
}
