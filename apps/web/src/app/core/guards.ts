import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import type { Role } from '@raaye/contracts';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.user()) return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
  if (!auth.me()) return router.createUrlTree(['/no-access']);
  return true;
};

export const anonymousGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.user() && auth.me()) return router.createUrlTree(['/overview']);
  return true;
};

export function roleGuard(roles: Role[]): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    return auth.hasRole(...roles) ? true : router.createUrlTree(['/overview'], { queryParams: { denied: '1' } });
  };
}

export const simulatorGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.simulatorEnabled() ? true : router.createUrlTree(['/overview']);
};
