import { HttpErrorResponse } from '@angular/common/http';
import { ApiError } from './api.service';

describe('ApiError.from', () => {
  it('keeps the API error code, message, field errors and correlation id', () => {
    const response = new HttpErrorResponse({ status: 422, error: { code: 'VALIDATION_FAILED', message: 'Check the form', correlationId: 'abc-123', fieldErrors: [{ path: 'phone', message: 'Invalid phone number' }] } });
    const error = ApiError.from(response);
    expect(error).toMatchObject({ status: 422, code: 'VALIDATION_FAILED', message: 'Check the form', correlationId: 'abc-123' });
    expect(error.fieldErrors).toEqual([{ path: 'phone', message: 'Invalid phone number' }]);
  });

  it('turns transport failures into an actionable message', () => {
    expect(ApiError.from(new HttpErrorResponse({ status: 0 }))).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(ApiError.from(new HttpErrorResponse({ status: 502, error: '<html>' })).message).toContain('502');
    expect(ApiError.from(new Error('boom')).message).toBe('boom');
  });
});
