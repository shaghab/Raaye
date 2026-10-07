import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { from, switchMap, tap, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AuthService } from './auth.service';

/** Attaches the Firebase ID token to API calls; a rejected token sends the user back to sign-in. */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  if (!request.url.startsWith('/api/')) return next(request);
  const auth = inject(AuthService);
  const router = inject(Router);
  return from(auth.idToken()).pipe(
    switchMap((token) => next(token ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : request)),
    tap({ error: () => undefined }),
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && error.status === 401 && auth.user()) {
        void auth.signOut().then(() => router.navigate(['/login'], { queryParams: { reason: 'expired' } }));
      }
      return throwError(() => error);
    }),
  );
};
