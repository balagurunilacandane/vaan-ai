// One POST with backoff, and one streaming POST. Every adapter goes through
// here so retry behaviour is identical no matter which endpoint Vaan is pointed
// at, and so there is one place that knows how to read a server-sent stream.

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

export interface SseFrame {
  event?: string;
  data: string;
}

/**
 * POST and read the response as server-sent events.
 *
 * Deliberately not retried. A stream that failed halfway has already handed the
 * caller half a turn, and replaying it from the top would duplicate whatever
 * was already yielded. The caller falls back to `generate` instead.
 */
export async function* postSse(url: string, opts: PostOptions): AsyncGenerator<SseFrame> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...opts.headers },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });

  if (!response.ok) {
    throw new HttpError(response.status, await response.text().catch(() => ""), url);
  }
  if (!response.body) throw new Error(`${new URL(url).host} sent no body to stream.`);

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    // Frames are separated by a blank line. Anything after the last one is a
    // partial frame and stays in the buffer until the rest of it arrives.
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const frame = parseFrame(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
      if (frame) yield frame;
      split = buffer.indexOf("\n\n");
    }
  }
  const last = parseFrame(buffer);
  if (last) yield last;
}

function parseFrame(raw: string): SseFrame | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return undefined;
  return { ...(event ? { event } : {}), data: data.join("\n") };
}

/** SSE payloads are JSON, except when they're a sentinel like `[DONE]`. */
export function parseFrameData(data: string): unknown {
  if (data === "[DONE]") return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
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
