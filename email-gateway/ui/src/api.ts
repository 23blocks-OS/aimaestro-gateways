const API_BASE = '/api'

export async function fetchAPI<T = unknown>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`API error ${response.status}: ${text}`)
  }

  return response.json()
}

export function patchAPI<T = unknown>(path: string, data: unknown): Promise<T> {
  return fetchAPI<T>(path, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}
