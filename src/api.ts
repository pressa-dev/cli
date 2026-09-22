export interface CompileResponse {
  job_id: string;
  pdf_url: string;
  expires_at: string;
  pages: number;
  compilation_time_ms: number;
  assets_count?: number;
  assets_total_bytes?: number;
  stored_assets_used?: string[];
  ephemeral_assets_used?: string[];
  // Present when the document exceeded the plan's page or source-size limit
  // and the PDF is what the plan delivers of it (the first `pages` of
  // `total_pages`). `plan_required` names the smallest plan that covers the
  // whole document; `warning` says all of that in one sentence.
  preview?: boolean;
  truncated?: boolean;
  total_pages?: number;
  plan_required?: string | null;
  warning?: string;
  upgrade_url?: string;
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
  limits?: {
    max_pages_per_document: number;
    max_latex_bytes_per_document: number;
    max_pdf_bytes_per_document: number;
    compile_timeout_seconds: number;
    allowed_compilers: string[];
  };
  templates?: {
    count: number;
    limit: number | null;
    remaining: number | null;
  };
}

export interface CompileError {
  error: string;
  log?: string;
  error_line?: number;
  message?: string;
  upgrade_url?: string;
  plan?: string;
}

export interface RenderResponse {
  job_id: string;
  pdf_url: string;
  expires_at: string;
  pages: number;
  render_time_ms: number;
  compilation_time_ms: number;
  template: {
    id: number;
    name: string;
    version: number;
  };
  usage?: {
    plan: string;
    compilations_this_month: number;
    monthly_limit: number | null;
  };
}

export interface TemplateListItem {
  id: number;
  name: string;
  description: string | null;
  updated_at: string;
  latex_size_bytes: number;
  has_instructions: boolean;
}

export interface TemplateListResponse {
  templates: TemplateListItem[];
}

export interface TemplateResponse {
  id: number;
  name: string;
  description: string | null;
  latex_content: string;
  instructions: string | null;
  updated_at: string;
  latex_size_bytes: number;
}

export interface TemplateSaveResponse {
  template: TemplateResponse;
  created: boolean;
}

export interface Asset {
  id: number;
  name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  updated_at: string;
  content_base64?: string;
}

export interface AssetListResponse {
  assets: Asset[];
  count: number;
  total_bytes: number;
  count_limit: number | null;
  total_bytes_limit: number;
  remaining_bytes: number | null;
}

export interface AssetSaveResponse {
  asset: Asset;
  created: boolean;
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
  /**
   * `apiKey` may be null. A null key means anonymous mode: no Authorization
   * header is sent and the server serves the keyless tier on
   * POST /api/v1/compile. Every other endpoint will answer 401, which is
   * correct - those genuinely need an account.
   *
   * This exists so an agent that finds Pressa with no credentials can still
   * produce a PDF instead of stopping to ask its human for a key. A tool that
   * refuses to run before setup is a tool the agent routes around.
   */
  constructor(
    private apiKey: string | null,
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
    assets?: Record<string, string>,
    useStoredAssets?: string[],
  ): Promise<CompileResponse> {
    const body: Record<string, unknown> = { latex };
    if (compiler) {
      body.compiler = compiler;
    }
    if (assets && Object.keys(assets).length > 0) {
      body.assets = assets;
    }
    if (useStoredAssets && useStoredAssets.length > 0) {
      body.use_stored_assets = useStoredAssets;
    }
    return this.request('POST', '/api/v1/compile', body) as Promise<CompileResponse>;
  }

  async renderTemplate(
    idOrName: string,
    data: Record<string, unknown>,
  ): Promise<RenderResponse> {
    const encoded = encodeURIComponent(idOrName);
    return this.request('POST', `/api/v2/templates/${encoded}/render`, { data }) as Promise<RenderResponse>;
  }

  async usage(): Promise<UsageResponse> {
    return this.request('GET', '/api/v1/usage') as Promise<UsageResponse>;
  }

  async downloadPdf(url: string): Promise<ArrayBuffer> {
    // Validate PDF URL — must be HTTPS from a trusted domain
    try {
      const pdfUrl = new URL(url);
      if (pdfUrl.protocol !== 'https:' && pdfUrl.hostname !== 'localhost' && pdfUrl.hostname !== '127.0.0.1') {
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

  async listTemplates(): Promise<TemplateListResponse> {
    return this.request('GET', '/api/v1/templates') as Promise<TemplateListResponse>;
  }

  async getTemplate(idOrName: string): Promise<{ template: TemplateResponse }> {
    const encoded = encodeURIComponent(idOrName);
    return this.request('GET', `/api/v1/templates/${encoded}`) as Promise<{ template: TemplateResponse }>;
  }

  async saveTemplate(
    name: string,
    latexContent: string,
    description?: string,
    instructions?: string,
  ): Promise<TemplateSaveResponse> {
    const body: Record<string, string> = { name, latex_content: latexContent };
    if (description) body.description = description;
    if (instructions !== undefined) body.instructions = instructions;
    return this.request('POST', '/api/v1/templates', body) as Promise<TemplateSaveResponse>;
  }

  async deleteTemplate(idOrName: string): Promise<void> {
    const encoded = encodeURIComponent(idOrName);
    await this.request('DELETE', `/api/v1/templates/${encoded}`);
  }

  async listAssets(): Promise<AssetListResponse> {
    return this.request('GET', '/api/v1/assets') as Promise<AssetListResponse>;
  }

  async getAsset(idOrName: string): Promise<{ asset: Asset }> {
    const encoded = encodeURIComponent(idOrName);
    return this.request('GET', `/api/v1/assets/${encoded}`) as Promise<{ asset: Asset }>;
  }

  async saveAsset(
    name: string,
    contentBase64: string,
    contentType?: string,
  ): Promise<AssetSaveResponse> {
    const body: Record<string, string> = { name, content_base64: contentBase64 };
    if (contentType) body.content_type = contentType;
    return this.request('POST', '/api/v1/assets', body) as Promise<AssetSaveResponse>;
  }

  async deleteAsset(idOrName: string): Promise<void> {
    const encoded = encodeURIComponent(idOrName);
    await this.request('DELETE', `/api/v1/assets/${encoded}`);
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    // Omit the header entirely when anonymous. Sending an empty or bogus
    // Bearer value would get a 401 instead of the anonymous tier: the server
    // deliberately treats a PRESENT but invalid key as a hard error so a
    // mistyped key fails loudly rather than silently degrading.
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

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

    if (response.status === 204) {
      return {};
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
