// The network boundary for tools.
//
// The provider adapters don't come through here — talking to the model is the
// one network call the user configured on purpose. Everything the *model* asks
// for does, and the interesting case isn't the public internet. It's the local
// one: a page that says "fetch http://169.254.169.254/latest/meta-data/" is
// asking the agent to read cloud credentials from inside the trust boundary,
// and a page that says "fetch http://localhost:8080/admin" is asking it to
// reach something the firewall thinks is safe because it's local.
//
// So loopback and private ranges are refused by default, and text from a page
// is information rather than instruction wherever it ends up.

export interface NetworkPolicy {
  /** Hosts always permitted, e.g. an internal docs server the user named. */
  allow: string[];
  /** Hosts never permitted, checked before `allow`. */
  deny: string[];
  /** Let the agent reach 127.0.0.1 and friends. Off unless the user says so. */
  allowLocal: boolean;
}

export const DEFAULT_NETWORK_POLICY: NetworkPolicy = { allow: [], deny: [], allowLocal: false };

/** Link-local, loopback, and the ranges that are only reachable from inside. */
const PRIVATE_HOSTS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // includes the cloud metadata address
  /^::1$/,
  /^\[::1\]$/,
  /^f[cd][0-9a-f]{2}:/i,
  /\.local$/i,
  /\.internal$/i,
];

export interface UrlVerdict {
  ok: boolean;
  reason: string;
  host: string;
}

/** Decide whether a tool may fetch this URL, before any permission prompt. */
export function checkUrl(raw: string, policy: NetworkPolicy = DEFAULT_NETWORK_POLICY): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL", host: "" };
  }
  const host = url.hostname;

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `${url.protocol} is not a scheme Vaan fetches`, host };
  }
  if (policy.deny.some((entry) => hostMatches(entry, host))) {
    return { ok: false, reason: "host is on the deny list", host };
  }
  if (policy.allow.some((entry) => hostMatches(entry, host))) {
    return { ok: true, reason: "host is on the allow list", host };
  }
  if (!policy.allowLocal && PRIVATE_HOSTS.some((pattern) => pattern.test(host))) {
    return {
      ok: false,
      reason:
        "that address is on this machine or its private network, which the agent doesn't reach",
      host,
    };
  }
  return { ok: true, reason: "public host", host };
}

const hostMatches = (entry: string, host: string): boolean =>
  entry.toLowerCase() === host.toLowerCase() || host.toLowerCase().endsWith(`.${entry.toLowerCase()}`);

export const MAX_FETCH_BYTES = 200_000;
const FETCH_TIMEOUT_MS = 20_000;

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

/**
 * Fetch a page as text, with a size cap and a timeout.
 *
 * Redirects are followed by `fetch`, so the final URL is re-checked: a public
 * URL that 302s to 169.254.169.254 would otherwise walk straight past the
 * check above.
 */
export async function fetchText(
  raw: string,
  policy: NetworkPolicy = DEFAULT_NETWORK_POLICY,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const verdict = checkUrl(raw, policy);
  if (!verdict.ok) throw new Error(`${raw}: ${verdict.reason}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const response = await fetch(raw, {
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
    });

    const landed = checkUrl(response.url || raw, policy);
    if (!landed.ok) throw new Error(`${raw} redirected to ${landed.host}: ${landed.reason}`);

    const body = await response.text();
    return {
      url: response.url || raw,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      text: body.slice(0, MAX_FETCH_BYTES),
      truncated: body.length > MAX_FETCH_BYTES,
    };
  } finally {
    clearTimeout(timer);
  }
}

const BLOCK_TAGS = /<(script|style|noscript|template|svg)[^>]*>[\s\S]*?<\/\1>/gi;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

/** HTML to something a model can read. Not a browser, and doesn't pretend to be. */
export function toReadableText(html: string): string {
  return html
    .replace(BLOCK_TAGS, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
