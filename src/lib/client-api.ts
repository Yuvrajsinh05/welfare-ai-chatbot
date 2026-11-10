/** Browser fetch helper: JSON in, JSON out, and server errors become readable messages. Cookies carry identity. */
export async function requestJson<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  // A platform timeout can return an HTML page instead of JSON; don't crash on it.
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? 'We couldn’t reach the service. Your message is still in the box, please try again.');
  return data as T;
}
