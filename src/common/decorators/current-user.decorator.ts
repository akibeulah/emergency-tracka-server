import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** What a verified access token carries. Set on `req.user` by the JWT strategy. */
export interface AuthUser {
  userId: string;
  facilityCode: string;
  role: string;
  permissions: string[];
  sessionId: string;
  deviceId: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
