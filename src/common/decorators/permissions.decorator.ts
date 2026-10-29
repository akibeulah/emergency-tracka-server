import { SetMetadata } from '@nestjs/common';
import { Permission } from '../permissions';

export const PERMISSIONS_KEY = 'permissions';
/** The caller needs every listed permission. Enforced by PermissionsGuard. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export const ROSTER_KEY = 'rosterPermission';
/** An action gated by the week's duty roster (2-11). Enforced by RosterGuard. */
export const RequireOnDuty = (permission: Permission) => SetMetadata(ROSTER_KEY, permission);
