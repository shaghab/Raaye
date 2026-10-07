import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { ApiErrorBody, ErrorCode, FieldError } from '@raaye/contracts';
import { firstValueFrom } from 'rxjs';

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[];
export type Query = Record<string, QueryValue>;

/** Typed, actionable API failure as returned by the Raaye API (never a raw transport error). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly correlationId: string | null = null,
    readonly fieldErrors: FieldError[] = [],
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
  }

  static from(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    if (error instanceof HttpErrorResponse) {
      const body: unknown = error.error;
      if (isApiErrorBody(body)) return new ApiError(error.status, body.code, body.message, body.correlationId, body.fieldErrors ?? [], body.details ?? null);
      if (error.status === 0) return new ApiError(0, 'NETWORK_ERROR', 'The API could not be reached. Check that the server is running.');
      return new ApiError(error.status, 'INTERNAL_ERROR', `Request failed with HTTP ${error.status}`);
    }
    return new ApiError(0, 'NETWORK_ERROR', error instanceof Error ? error.message : 'Unexpected error');
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === 'object' && value !== null && typeof (value as ApiErrorBody).code === 'string' && typeof (value as ApiErrorBody).message === 'string';
}

function toParams(query: Query | undefined): HttpParams {
  let params = new HttpParams();
  if (!query) return params;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) params = params.append(key, String(item));
    } else params = params.set(key, String(value));
  }
  return params;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  readonly base = '/api/v1';

  async get<T>(path: string, query?: Query): Promise<T> {
    return this.run(firstValueFrom(this.http.get<T>(`${this.base}${path}`, { params: toParams(query) })));
  }

  async post<T>(path: string, body: unknown = {}, options: { idempotencyKey?: string } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    return this.run(firstValueFrom(this.http.post<T>(`${this.base}${path}`, body, { headers })));
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.run(firstValueFrom(this.http.patch<T>(`${this.base}${path}`, body)));
  }

  async delete<T>(path: string): Promise<T> {
    return this.run(firstValueFrom(this.http.delete<T>(`${this.base}${path}`)));
  }

  async upload<T>(path: string, file: File): Promise<T> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.run(firstValueFrom(this.http.post<T>(`${this.base}${path}`, form)));
  }

  /** Authenticated download: fetches the file as a blob and hands it to the browser. */
  async download(path: string, query?: Query): Promise<string> {
    const params = toParams(query);
    const response = await this.run(firstValueFrom(this.http.get(`${this.base}${path}`, { params, observe: 'response', responseType: 'blob' })));
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const filename = match?.[1] ?? 'download';
    const blob = response.body ?? new Blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return filename;
  }

  private async run<T>(promise: Promise<T>): Promise<T> {
    try {
      return await promise;
    } catch (error) {
      throw ApiError.from(error);
    }
  }
}

export function idempotencyKey(prefix: string): string {
  const random = crypto.randomUUID();
  return `${prefix}-${random}`;
}
