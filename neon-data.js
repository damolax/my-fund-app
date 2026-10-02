(() => {
  'use strict'

  function encodeFilter(value) {
    if (value === null) return 'null'
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    return String(value)
  }

  function parseResponseBody(text) {
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  function createError(response, body) {
    const message =
      (body && typeof body === 'object' && (body.message || body.details || body.hint)) ||
      (typeof body === 'string' && body) ||
      `Neon Data API request failed with status ${response.status}`
    const error = new Error(message)
    error.status = response.status
    if (body && typeof body === 'object') Object.assign(error, body)
    return error
  }

  class QueryBuilder {
    constructor(client, table) {
      this.client = client
      this.table = table
      this.method = 'GET'
      this.body = null
      this.filters = []
      this.orders = []
      this.columns = '*'
      this.returnRepresentation = false
      this.singleMode = null
      this.onConflict = ''
      this.upsert = false
      this._promise = null
    }

    select(columns = '*') {
      this.columns = columns || '*'
      if (this.method !== 'GET') this.returnRepresentation = true
      return this
    }

    insert(payload) {
      this.method = 'POST'
      this.body = payload
      return this
    }

    update(payload) {
      this.method = 'PATCH'
      this.body = payload
      return this
    }

    delete() {
      this.method = 'DELETE'
      return this
    }

    upsert(payload, options = {}) {
      this.method = 'POST'
      this.body = payload
      this.upsert = true
      this.onConflict = options.onConflict || ''
      return this
    }

    eq(column, value) {
      this.filters.push([column, `eq.${encodeFilter(value)}`])
      return this
    }

    order(column, options = {}) {
      this.orders.push(`${column}.${options.ascending === false ? 'desc' : 'asc'}`)
      return this
    }

    single() {
      this.singleMode = 'single'
      return this._execute()
    }

    maybeSingle() {
      this.singleMode = 'maybe'
      return this._execute()
    }

    then(resolve, reject) {
      return this._execute().then(resolve, reject)
    }

    catch(reject) {
      return this._execute().catch(reject)
    }

    finally(callback) {
      return this._execute().finally(callback)
    }

    _execute() {
      if (!this._promise) this._promise = this.client._runTableQuery(this)
      return this._promise
    }
  }

  class NeonDataClient {
    constructor(baseUrl, getAccessToken) {
      this.baseUrl = String(baseUrl || '').replace(/\/$/, '')
      this.getAccessToken = typeof getAccessToken === 'function' ? getAccessToken : () => null
    }

    from(table) {
      return new QueryBuilder(this, table)
    }

    async rpc(functionName, args = {}) {
      return this._request(`/rpc/${encodeURIComponent(functionName)}`, {
        method: 'POST',
        body: args,
        prefer: 'return=representation',
      })
    }

    async _runTableQuery(builder) {
      const params = new URLSearchParams()
      if (builder.columns) params.set('select', builder.columns)
      for (const [key, value] of builder.filters) params.append(key, value)
      if (builder.orders.length) params.set('order', builder.orders.join(','))
      if (builder.onConflict) params.set('on_conflict', builder.onConflict)

      let prefer = builder.returnRepresentation ? 'return=representation' : 'return=minimal'
      if (builder.upsert) prefer = `resolution=merge-duplicates,${prefer}`

      const result = await this._request(
        `/${encodeURIComponent(builder.table)}${params.toString() ? `?${params.toString()}` : ''}`,
        {
          method: builder.method,
          body: builder.body,
          prefer,
        },
      )

      if (result.error) return result
      let data = result.data

      if (builder.singleMode) {
        const rows = Array.isArray(data) ? data : data == null ? [] : [data]
        if (builder.singleMode === 'single') {
          if (rows.length !== 1) {
            return { data: null, error: new Error(`Expected one row but received ${rows.length}.`) }
          }
          data = rows[0]
        } else {
          if (rows.length > 1) {
            return { data: null, error: new Error(`Expected zero or one row but received ${rows.length}.`) }
          }
          data = rows[0] || null
        }
      }

      return { data, error: null }
    }

    async _request(path, options = {}) {
      try {
        const token = await this.getAccessToken()
        const headers = {
          Accept: 'application/json',
        }
        if (options.body !== undefined && options.body !== null) headers['Content-Type'] = 'application/json'
        if (token) headers.Authorization = `Bearer ${token}`
        if (options.prefer) headers.Prefer = options.prefer

        const response = await fetch(`${this.baseUrl}${path}`, {
          method: options.method || 'GET',
          headers,
          body: options.body === undefined || options.body === null ? undefined : JSON.stringify(options.body),
        })
        const text = await response.text()
        const body = parseResponseBody(text)
        if (!response.ok) return { data: null, error: createError(response, body) }
        return { data: body, error: null }
      } catch (error) {
        return { data: null, error: error instanceof Error ? error : new Error(String(error)) }
      }
    }
  }

  window.createNeonDataClient = (baseUrl, getAccessToken) => new NeonDataClient(baseUrl, getAccessToken)
})()
