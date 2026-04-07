export interface CompileResponse {
  job_id: string;
  pdf_url: string;
  expires_at: string;
  pages: number;
  compilation_time_ms: number;
  usage?: {
    plan: string;
    compilations_this_month: number;
    monthly_limit: number | null;
  };
}

export interface UsageResponse {
  user: {
    email: string;
    username: string;
    plan: string;
  };
  usage: {
    compilations_this_month: number;
    monthly_limit: number | null;
    remaining: number | null;
    resets_at: string;
  };
  api_key: {
    prefix: string;
    name: string;
    total_requests: number;
    last_used_at: string;
  };
}

export interface CompileError {
  error: string;
  log?: string;
  error_line?: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    const msg = (body.error as string) || `API error (HTTP ${status})`;
    super(msg);
    this.name = 'ApiError';
  }
}

export class PressaAPI {
  constructor(
    private apiKey: string,
    private baseUrl: string,
  ) {
    // Enforce HTTPS unless explicitly localhost (for development)
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error('API URL must use HTTPS. Use localhost for development.');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async compile(
    latex: string,
    compiler?: string,
  ): Promise<CompileResponse> {
    const body: Record<string, string> = { latex };
    if (compiler) {
      body.compiler = compiler;
    }
    return this.request('POST', '/api/v1/compile', body) as Promise<CompileResponse>;
  }

  async usage(): Promise<UsageResponse> {
    return this.request('GET', '/api/v1/usage') as Promise<UsageResponse>;
  }

  async downloadPdf(url: string): Promise<ArrayBuffer> {
    // Validate PDF URL — must be HTTPS from a trusted domain
    try {
      const pdfUrl = new URL(url);
      if (pdfUrl.protocol !== 'https:') {
        throw new Error('PDF URL must use HTTPS.');
      }
    } catch (e) {
      if (e instanceof TypeError) {
        throw new Error('Invalid PDF URL received from API.');
      }
      throw e;
    }

    // PDF URLs are pre-signed and don't require auth headers
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        throw new ApiError(response.status, {
          error: `Failed to download PDF (HTTP ${response.status})`,
        });
      }

      return response.arrayBuffer();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('PDF download timed out after 60s.');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Accept': 'application/json',
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timeoutMs = method === 'POST' ? 120_000 : 10_000; // 120s for compile, 10s for others
    const requestTimeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs / 1000}s.`);
      }
      // Sanitize URL in error messages (strip credentials)
      const safeUrl = new URL(this.baseUrl);
      safeUrl.username = '';
      safeUrl.password = '';
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Connection failed: ${message}\nIs the API running at ${safeUrl.origin}?`);
    } finally {
      clearTimeout(requestTimeout);
    }

    let json: Record<string, unknown>;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new ApiError(response.status, {
        error: `Unexpected response (HTTP ${response.status})`,
      });
    }

    if (!response.ok) {
      throw new ApiError(response.status, json);
    }

    return json;
  }
}
