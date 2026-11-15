import { RailRejectedError, RailUnavailableError } from '@pialy/payments';
import { z } from 'zod';
import { errorBodySchema } from './schemas.js';

export interface PeyHttpClientConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface PeyHttpClient {
  get<Out>(path: string, schema: z.ZodType<Out>, query?: Readonly<Record<string, string>>): Promise<Out>;
  post<Out>(path: string, body: unknown, schema: z.ZodType<Out>): Promise<Out>;
}

type HttpMethod = 'GET' | 'POST';

/** What one attempt produced: an HTTP response, or the error that prevented one. */
type Exchange = { readonly status: number; readonly text: string } | { readonly error: unknown };

/** Waits before attempts 2 and 3; its length caps a call at 3 attempts. */
const RETRY_DELAYS_MS = [200, 400] as const;
/**
 * A POST creates a charge, so it is retried only when the response proves pey did not
 * process it (gateway error, maintenance). Timeouts and other 5xx are never re-sent.
 */
const POST_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503]);
const HTTP_SUCCESS_MIN = 200;
const HTTP_REDIRECT_MIN = 300;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;
const MAX_PROVIDER_MESSAGE_LENGTH = 300;
/** Phone numbers and CLABEs pey might echo back are masked down to their last digits. */
const LONG_DIGIT_RUN = /\d{10,}/g;
const VISIBLE_TRAILING_DIGITS = 4;

export function createPeyHttpClient(config: PeyHttpClientConfig): PeyHttpClient {
  const baseUrl = new URL(config.baseUrl).toString().replace(/\/+$/, '');
  const { apiKey, timeoutMs, sleep, fetch: fetchFn } = config;

  async function exchange(method: HttpMethod, url: string, body: unknown): Promise<Exchange> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      const response = await fetchFn(url, init);
      return { status: response.status, text: await response.text() };
    } catch (error) {
      return { error };
    }
  }

  async function request<Out>(
    method: HttpMethod,
    path: string,
    url: string,
    body: unknown,
    schema: z.ZodType<Out>,
  ): Promise<Out> {
    for (let attempt = 0; ; attempt += 1) {
      const result = await exchange(method, url, body);
      const retryDelayMs = RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isRetryable(method, result)) {
        return settle(`${method} ${path}`, result, schema);
      }
      await sleep(retryDelayMs);
    }
  }

  return {
    get(path, schema, query) {
      const search = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
      return request('GET', path, `${baseUrl}${path}${search}`, undefined, schema);
    },
    post(path, body, schema) {
      return request('POST', path, `${baseUrl}${path}`, body, schema);
    },
  };
}

function isRetryable(method: HttpMethod, result: Exchange): boolean {
  if ('error' in result) return method === 'GET';
  if (method === 'GET') return result.status >= HTTP_SERVER_ERROR_MIN;
  return POST_RETRYABLE_STATUSES.has(result.status);
}

function settle<Out>(label: string, result: Exchange, schema: z.ZodType<Out>): Out {
  if ('error' in result) {
    throw new RailUnavailableError(`pey ${label} failed: ${describeFailure(result.error)}`, {
      cause: result.error,
    });
  }
  const { status, text } = result;
  if (status >= HTTP_SUCCESS_MIN && status < HTTP_REDIRECT_MIN) {
    return parseSuccess(label, status, text, schema);
  }
  const problem = readProblem(text);
  if (status >= HTTP_CLIENT_ERROR_MIN && status < HTTP_SERVER_ERROR_MIN) {
    const providerMessage = problem.message ?? `HTTP ${status}`;
    throw new RailRejectedError(`pey rejected ${label} (${status}): ${providerMessage}`, {
      status,
      providerMessage,
      providerCode: problem.code,
      requestId: problem.requestId,
    });
  }
  const detail = problem.message === undefined ? '' : `: ${problem.message}`;
  throw new RailUnavailableError(`pey ${label} responded ${status}${detail}`, { status });
}

function parseSuccess<Out>(label: string, status: number, text: string, schema: z.ZodType<Out>): Out {
  const json = parseJson(text);
  if (!json.ok) {
    throw new RailUnavailableError(`pey ${label} returned a non-JSON body`, { status });
  }
  const parsed = schema.safeParse(json.value);
  if (!parsed.success) {
    throw new RailUnavailableError(
      `pey ${label} returned an unexpected body: ${z.prettifyError(parsed.error)}`,
      { status },
    );
  }
  return parsed.data;
}

interface Problem {
  readonly message: string | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
}

function readProblem(text: string): Problem {
  const json = parseJson(text);
  const body = json.ok ? errorBodySchema.safeParse(json.value) : undefined;
  const data = body?.success ? body.data : undefined;
  const message = data?.error?.message ?? data?.message;
  return {
    message: message === undefined ? undefined : redact(message),
    code: data?.error?.type,
    requestId: data?.error?.requestId ?? undefined,
  };
}

function redact(providerMessage: string): string {
  return providerMessage
    .replace(
      LONG_DIGIT_RUN,
      (run) => '*'.repeat(run.length - VISIBLE_TRAILING_DIGITS) + run.slice(-VISIBLE_TRAILING_DIGITS),
    )
    .slice(0, MAX_PROVIDER_MESSAGE_LENGTH);
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'request timed out' : error.message;
  }
  return 'unknown error';
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
