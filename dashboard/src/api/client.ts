export interface DashboardApiErrorBody {
  error?: string | { message?: string }
  message?: string
}

export class DashboardApiError extends Error {
  public readonly status: number
  public readonly path: string

  constructor(status: number, path: string, message: string) {
    super(message)
    this.name = 'DashboardApiError'
    this.status = status
    this.path = path
  }
}

export interface DashboardApiClientOptions {
  baseUrl: string
  token?: string
  fetchImpl?: typeof fetch
}

/**
 * The one transport used by Dashboard queries and commands. Domain models are
 * supplied by callers while this class owns URL, authentication and error
 * semantics; views must never create ad-hoc authorization rules.
 */
export class DashboardApiClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly options: DashboardApiClientOptions

  constructor(options: DashboardApiClientOptions) {
    this.options = options
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    // Browser fetch is a host function. Calling a stored reference as
    // `this.fetchImpl(...)` would otherwise bind DashboardApiClient as its
    // receiver and Safari/WebKit rejects that with "Illegal invocation".
    this.fetchImpl = (input, init) => fetchImpl(input, init)
  }

  headers(json = false): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`
    if (json) headers['Content-Type'] = 'application/json'
    return headers
  }

  async response(path: string, init: RequestInit = {}): Promise<Response> {
    const json = init.body !== undefined
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.headers(json),
        ...(init.headers ?? {}),
      },
    })
  }

  async get<T>(path: string): Promise<T> {
    return this.readJson<T>(path, await this.response(path))
  }

  async tryGet<T>(path: string): Promise<T | undefined> {
    const response = await this.response(path)
    if (!response.ok) return undefined
    return response.json() as Promise<T>
  }

  async command<T>(path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
    const response = await this.response(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return this.readJson<T>(path, response, true)
  }

  private async readJson<T>(path: string, response: Response, allowEmpty = false): Promise<T> {
    if (response.ok) {
      if (allowEmpty && (response.status === 204 || response.headers.get('content-length') === '0')) {
        return undefined as T
      }
      const text = await response.text()
      if (allowEmpty && !text.trim()) return undefined as T
      return JSON.parse(text) as T
    }
    let detail = `HTTP ${response.status}`
    try {
      const body = await response.json() as DashboardApiErrorBody
      detail = typeof body.error === 'string'
        ? body.error
        : body.error?.message ?? body.message ?? detail
    } catch {
      // Some gateways return an empty or HTML error response.
    }
    throw new DashboardApiError(response.status, path, detail)
  }
}
