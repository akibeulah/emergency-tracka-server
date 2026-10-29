import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import Redis from 'ioredis';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { Env } from '../../config/env.schema';
import { REDIS } from '../../config/redis.module';
import { activeSessionKey } from './sessions.service';

export interface AccessTokenClaims {
  sub: string;
  fc: string;
  role: string;
  perms: string[];
  sid: string;
  did: string;
}

export function claimsToUser(c: AccessTokenClaims): AuthUser {
  return {
    userId: c.sub,
    facilityCode: c.fc,
    role: c.role,
    permissions: c.perms ?? [],
    sessionId: c.sid,
    deviceId: c.did,
  };
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService<Env, true>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_ACCESS_SECRET', { infer: true }),
    });
  }

  /** A signed token is not enough: its session must still be in the active set (fast revoke). */
  async validate(claims: AccessTokenClaims): Promise<AuthUser> {
    if (!(await this.redis.exists(activeSessionKey(claims.sid)))) {
      throw new UnauthorizedException('Your session has ended. Please sign in again.');
    }
    return claimsToUser(claims);
  }
}
