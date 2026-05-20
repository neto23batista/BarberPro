export const COOKIE_SESSION = 'cookie-session';

export async function apiRequest(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
    ...(options.token && options.token !== COOKIE_SESSION ? { Authorization: `Bearer ${options.token}` } : {})
  };

  const response = await fetch(path, {
    method: options.method || 'GET',
    headers,
    credentials: 'include',
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    const error = new Error(payload?.error || 'Nao foi possivel concluir a solicitacao.');
    error.code = payload?.code;
    error.details = payload?.details;
    error.persistence = payload?.persistence;
    if (error.code === 'PERSISTENCE_UNAVAILABLE' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('barberpro:persistence-error', { detail: payload.persistence }));
    }
    throw error;
  }

  return payload;
}

export async function downloadWithAuth(path, token, filename, headers = {}) {
  const response = await fetch(path, {
    headers: {
      ...headers,
      ...(token && token !== COOKIE_SESSION ? { Authorization: `Bearer ${token}` } : {})
    },
    credentials: 'include'
  });

  if (!response.ok) {
    const payload = (response.headers.get('content-type') || '').includes('application/json')
      ? await response.json()
      : null;
    const error = new Error(payload?.error || 'Falha ao gerar arquivo.');
    error.code = payload?.code;
    throw error;
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
