export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const unauthorized = (message = "Unauthorized") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "Forbidden") => new HttpError(403, "forbidden", message);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const conflict = (message: string) => new HttpError(409, "conflict", message);
export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const payloadTooLarge = (message = "Payload too large") => new HttpError(413, "payload_too_large", message);
export const quotaExceeded = (message = "Storage quota exceeded") => new HttpError(402, "quota_exceeded", message);
export const serviceUnavailable = (message = "Service unavailable") => new HttpError(503, "service_unavailable", message);
export const tooManyRequests = (message = "Too many requests") => new HttpError(429, "too_many_requests", message);
