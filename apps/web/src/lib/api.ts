'use client';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${name}=`))
    ?.split('=')[1];
}

async function csrfToken(): Promise<string> {
  let token = readCookie('vs_csrf');
  if (!token) {
    const res = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
    token = ((await res.json()) as { token: string }).token;
  }
  return token;
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    window.location.href = '/login';
  }
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg =
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error: string }).error)
        : `Request failed (${res.status})`;
    throw new ApiError(
      msg,
      res.status,
      typeof body === 'object' && body ? (body as { code?: string }).code : undefined,
    );
  }
  return body as T;
}

export async function apiGet<T>(url: string): Promise<T> {
  return handle<T>(await fetch(url, { credentials: 'same-origin', cache: 'no-store' }));
}

export async function apiSend<T>(
  url: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const token = await csrfToken();
  return handle<T>(
    await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

export async function apiBlob(url: string, body: unknown): Promise<Blob> {
  const token = await csrfToken();
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token },
    body: JSON.stringify(body),
  });
  if (!res.ok) await handle(res);
  return res.blob();
}

/** Multipart upload with progress (XMLHttpRequest exposes upload progress). */
export async function uploadFile<T>(
  url: string,
  file: File,
  fields: Record<string, string> = {},
  onProgress?: (fraction: number) => void,
): Promise<T> {
  const token = await csrfToken();
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', file);
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('x-csrf-token', token);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown = xhr.responseText;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* text */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else
        reject(
          new ApiError(
            typeof body === 'object' && body && 'error' in body
              ? String((body as { error: string }).error)
              : `Upload failed (${xhr.status})`,
            xhr.status,
          ),
        );
    };
    xhr.onerror = () => reject(new ApiError('Network error during upload', 0));
    xhr.send(form);
  });
}
