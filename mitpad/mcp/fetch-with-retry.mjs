const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function retryDelay(response, retryIndex) {
  const retryAfter = Number(response?.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1_000, 1_000);
  }
  return 250 * (retryIndex + 1);
}

/** Retries only safe reads; writes are never replayed automatically. */
export async function fetchWithRetry(url, init = {}, { timeoutMs = 20_000, retries = 1 } = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const canRetry = method === "GET" || method === "HEAD";
  const attempts = canRetry ? retries + 1 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (attempt + 1 >= attempts) throw error;
      await sleep(250 * (attempt + 1));
      continue;
    }

    if (!RETRYABLE_STATUSES.has(response.status) || attempt + 1 >= attempts) return response;
    await sleep(retryDelay(response, attempt));
    await response.body?.cancel().catch(() => {});
  }

  throw new Error("La solicitud no pudo completarse.");
}
