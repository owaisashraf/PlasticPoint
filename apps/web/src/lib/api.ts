/** Typed fetch wrapper. Errors come back as ApiError with a plain-language message. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly fields?: Record<string, string>,
    /** Extra data from the server, e.g. the issues behind APPROVAL_REQUIRED. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function request<T>(method: Method, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach ShopLedger. Check that it is running, then try again.', 'NETWORK');
  }
  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string; code?: string; fields?: Record<string, string>; details?: unknown })
    | null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? 'Something went wrong. Please try again.', data?.code, data?.fields, data?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  delete: <T>(url: string) => request<T>('DELETE', url),
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Please try again.';
}

/** The first field error from the server (e.g. "Cheque number is required"), else the general message. */
export function firstFieldError(e: unknown): string {
  return (e instanceof ApiError && e.fields ? Object.values(e.fields)[0] : undefined) ?? errorMessage(e);
}

/** Query string from filters, leaving out empty values (undefined, '' and false). */
export function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== false) p.set(k, String(v));
  return p.toString();
}

/** Logs a print through `printUrl` (a POST returning the PDF's url), then opens the PDF in a new tab. */
export async function printInNewTab(printUrl: string): Promise<void> {
  // Open the tab first (inside the click) so the browser does not block it.
  const tab = window.open('', '_blank');
  try {
    const { url } = await api.post<{ url: string }>(printUrl);
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (e) {
    tab?.close();
    throw e;
  }
}
