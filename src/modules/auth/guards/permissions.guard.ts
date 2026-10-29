import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from '../../../common/decorators/current-user.decorator';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { Permission } from '../../../common/permissions';

/** RBAC (2-4, G8). Runs after JwtAuthGuard. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required?.length) return true;

    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    const granted = new Set(user?.permissions ?? []);
    const missing = required.filter((p) => !granted.has(p));
    if (missing.length) {
      throw new ForbiddenException(`Your account does not have permission to do this (${missing.join(', ')}).`);
    }
    return true;
  }
}
