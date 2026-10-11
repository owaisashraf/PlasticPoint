/**
 * The official WhatsApp Business Platform (Cloud API), called with the
 * built-in fetch — no SDK (CLAUDE.md 13). The access token is sent only in
 * the Authorization header and is never logged or put in an error message.
 */

export type FetchFn = typeof fetch;

export interface CloudApiConfig {
  phoneNumberId: string;
  token: string;
  version: string;
  language: string;
}

/** A failure whose message is safe to show to the user. */
export class CloudApiError extends Error {
  override name = 'CloudApiError';
}

const TIMEOUT_MS = 30_000;

interface GraphError {
  message?: string;
  code?: number;
  error_data?: { details?: string };
}

async function graph<T>(fetchFn: FetchFn, cfg: CloudApiConfig, path: string, init: RequestInit = {}): Promise<T> {
  const url = `https://graph.facebook.com/${cfg.version}/${path}`;
  let res: Response;
  try {
    res = await fetchFn(url, {
      ...init,
      headers: { Authorization: `Bearer ${cfg.token}`, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new CloudApiError('Could not reach WhatsApp. Check the internet connection and try again.');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON; handled below.
  }
  if (!res.ok) {
    const err = (body as { error?: GraphError } | null)?.error;
    const detail = err?.error_data?.details || err?.message || `HTTP ${res.status}`;
    const text = `WhatsApp did not accept it: ${detail}${err?.code ? ` (code ${err.code})` : ''}`;
    throw new CloudApiError(cfg.token ? text.replaceAll(cfg.token, '***') : text);
  }
  return body as T;
}

/** Uploads a PDF and returns its media id. */
export async function uploadPdf(fetchFn: FetchFn, cfg: CloudApiConfig, pdf: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
  const body = await graph<{ id?: string }>(fetchFn, cfg, `${cfg.phoneNumberId}/media`, { method: 'POST', body: form });
  if (!body.id) throw new CloudApiError('WhatsApp did not return an id for the uploaded PDF.');
  return body.id;
}

export interface TemplateMessage {
  /** E.164 without the + (e.g. 923001234567). */
  to: string;
  template: string;
  /** Body parameters {{1}}, {{2}}, … in order. */
  params: string[];
  /** Document header (the uploaded PDF). */
  document?: { id: string; filename: string };
}

/** Sends an approved template message and returns WhatsApp's message id. */
export async function sendTemplate(fetchFn: FetchFn, cfg: CloudApiConfig, m: TemplateMessage): Promise<string> {
  const components: unknown[] = [];
  if (m.document) components.push({ type: 'header', parameters: [{ type: 'document', document: { id: m.document.id, filename: m.document.filename } }] });
  // Template parameters may not contain new lines or tabs.
  if (m.params.length) components.push({ type: 'body', parameters: m.params.map((text) => ({ type: 'text', text: text.replace(/\s+/g, ' ').trim() || '-' })) });
  const body = await graph<{ messages?: { id?: string }[] }>(fetchFn, cfg, `${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: m.to,
      type: 'template',
      template: { name: m.template, language: { code: cfg.language }, components },
    }),
  });
  const id = body.messages?.[0]?.id;
  if (!id) throw new CloudApiError('WhatsApp did not confirm the message.');
  return id;
}

/** Checks the phone number ID and token (Settings → WhatsApp → Test connection). */
export async function checkConnection(fetchFn: FetchFn, cfg: CloudApiConfig): Promise<{ display_phone_number: string | null; verified_name: string | null }> {
  const body = await graph<{ display_phone_number?: string; verified_name?: string }>(fetchFn, cfg, `${cfg.phoneNumberId}?fields=display_phone_number,verified_name`);
  return { display_phone_number: body.display_phone_number ?? null, verified_name: body.verified_name ?? null };
}
