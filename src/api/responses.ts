export interface ApiResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

export function badRequest(message: string): ApiResponse {
  return { statusCode: 400, body: { error: { code: 'bad_request', message } } };
}

export function forbidden(): ApiResponse {
  return { statusCode: 403, body: { error: { code: 'forbidden', message: 'Forbidden' } } };
}

export function notFound(): ApiResponse {
  return { statusCode: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
}

export function conflict(message: string): ApiResponse {
  return { statusCode: 409, body: { error: { code: 'optimistic_lock_conflict', message } } };
}

export function payloadTooLarge(message: string): ApiResponse {
  return { statusCode: 413, body: { error: { code: 'payload_too_large', message } } };
}
