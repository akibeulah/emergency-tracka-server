import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import Redis from 'ioredis';
import { Model, Types } from 'mongoose';
import { Env } from '../../config/env.schema';
import { REDIS } from '../../config/redis.module';
import { UserDocument } from '../users/schemas/user.schema';
import { AccessTokenClaims } from './jwt.strategy';
import { Session, SessionDocument } from './schemas/session.schema';

export const activeSessionKey = (sessionId: string) => `session:${sessionId}`;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  sessionId: string;
}

@Injectable()
export class SessionsService {
  constructor(
    @InjectModel(Session.name) private readonly sessions: Model<SessionDocument>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get refreshTtlSeconds() {
    return this.config.get('REFRESH_TTL_DAYS', { infer: true }) * 24 * 60 * 60;
  }

  async create(user: UserDocument, deviceId: string, ipAddress?: string): Promise<TokenPair> {
    const sessionId = new Types.ObjectId();
    const secret = randomBytes(32).toString('base64url');
    await this.sessions.create({
      _id: sessionId,
      userId: user._id,
      facilityCode: user.facilityCode,
      deviceId,
      refreshTokenHash: sha256(secret),
      lastActiveAt: new Date(),
      expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000),
      ipAddress,
    });
    await this.redis.set(activeSessionKey(sessionId.toHexString()), String(user._id), 'EX', this.refreshTtlSeconds);
    return this.issue(user, sessionId.toHexString(), deviceId, secret);
  }

  /**
   * Rotates the refresh secret. Presenting an old secret means it was copied:
   * the whole session is revoked.
   */
  async refresh(
    refreshToken: string,
    loadUser: (id: Types.ObjectId) => Promise<UserDocument | null>,
  ): Promise<TokenPair> {
    const [sessionId, secret] = refreshToken.split('.');
    if (!sessionId || !secret || !Types.ObjectId.isValid(sessionId)) throw this.ended();

    const session = await this.sessions.findById(sessionId).select('+refreshTokenHash');
    if (!session || session.revokedAt || session.expiresAt < new Date()) throw this.ended();

    const a = Buffer.from(sha256(secret), 'hex');
    const b = Buffer.from(session.refreshTokenHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await this.revoke(sessionId);
      throw this.ended();
    }

    const user = await loadUser(session.userId);
    if (!user || user.status !== 'active') {
      await this.revoke(sessionId);
      throw this.ended();
    }

    const next = randomBytes(32).toString('base64url');
    // Conditional on the hash we just checked, so two concurrent refreshes cannot both win.
    const rotated = await this.sessions.updateOne(
      { _id: session._id, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
      { $set: { refreshTokenHash: sha256(next), lastActiveAt: new Date() } },
    );
    if (rotated.modifiedCount !== 1) throw this.ended();

    return this.issue(user, sessionId, session.deviceId, next);
  }

  async revoke(sessionId: string): Promise<void> {
    await this.sessions.updateOne({ _id: sessionId, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await this.redis.del(activeSessionKey(sessionId));
  }

  /** Suspending a facility ends every session under its code. */
  async revokeWhere(filter: { facilityCode?: string; userId?: Types.ObjectId }): Promise<number> {
    const active = await this.sessions.find({ ...filter, revokedAt: null }, { _id: 1 }).lean();
    if (!active.length) return 0;
    await this.sessions.updateMany({ _id: { $in: active.map((s) => s._id) } }, { $set: { revokedAt: new Date() } });
    await this.redis.del(...active.map((s) => activeSessionKey(String(s._id))));
    return active.length;
  }

  /** Drops Redis entries for sessions Mongo says are over (backstop to the Redis TTL). */
  async purgeExpired(): Promise<number> {
    const stale = await this.sessions
      .find({ revokedAt: null, expiresAt: { $lt: new Date() } }, { _id: 1 })
      .limit(500)
      .lean();
    if (!stale.length) return 0;
    await this.sessions.updateMany({ _id: { $in: stale.map((s) => s._id) } }, { $set: { revokedAt: new Date() } });
    await this.redis.del(...stale.map((s) => activeSessionKey(String(s._id))));
    return stale.length;
  }

  private issue(user: UserDocument, sessionId: string, deviceId: string, secret: string): TokenPair {
    const ttl = this.config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
    const claims: AccessTokenClaims = {
      sub: String(user._id),
      fc: user.facilityCode,
      role: user.role,
      perms: user.permissions,
      sid: sessionId,
      did: deviceId,
    };
    return {
      accessToken: this.jwt.sign(claims, { expiresIn: ttl }),
      accessTokenExpiresIn: ttl,
      refreshToken: `${sessionId}.${secret}`,
      sessionId,
    };
  }

  private ended() {
    return new UnauthorizedException('Your session has ended. Please sign in again.');
  }
}
