// One POST with backoff. Every adapter goes through here so retry behaviour is
// identical no matter which endpoint Vaan is pointed at.

const RETRIES = 4;
const BASE_DELAY_MS = 500;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string,
  ) {
    super(`${new URL(url).host} returned ${status}: ${truncate(body, 400)}`);
    this.name = "HttpError";
  }
}

export interface PostOptions {
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
}

/** POST JSON, parse JSON back. Retries 429 and 5xx; everything else throws. */
export async function postJson(url: string, opts: PostOptions): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt, lastError));

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        body: JSON.stringify(opts.body),
        signal: opts.signal,
      });
    } catch (err) {
      // Connection reset, DNS hiccup, socket timeout. Worth another go —
      // unless the caller pulled the plug, in which case stop immediately.
      if (opts.signal?.aborted) throw err;
      lastError = err;
      continue;
    }

    if (response.ok) return response.json();

    const body = await response.text().catch(() => "");
    const error = new HttpError(response.status, body, url);
    if (!isRetryable(response.status)) throw error;
    lastError = { error, retryAfter: retryAfterMs(response) };
  }

  throw lastError instanceof Error
    ? lastError
    : ((lastError as { error?: Error })?.error ??
      new Error(`POST ${url} failed after ${RETRIES + 1} attempts`));
}

const isRetryable = (status: number) => status === 429 || status >= 500;

/** Honour Retry-After when the server sends one; otherwise exponential + jitter. */
function backoffMs(attempt: number, last: unknown): number {
  const hinted = (last as { retryAfter?: number } | undefined)?.retryAfter;
  if (hinted !== undefined) return Math.min(hinted, 30_000);
  return BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 250;
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}…`;
