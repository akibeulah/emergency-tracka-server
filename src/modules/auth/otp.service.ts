import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import Redis from 'ioredis';
import { Env } from '../../config/env.schema';
import { REDIS } from '../../config/redis.module';

const MAX_ATTEMPTS_PER_CODE = 5;
const RATE_WINDOW_SECONDS = 15 * 60;
const MAX_REQUESTS_PER_ACCOUNT = 5;
const MAX_REQUESTS_PER_IP = 30;

export const otpKey = (facilityCode: string, email: string) => `otp:${facilityCode}:${email}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Six-digit, single-use codes in Redis with a 5-minute TTL. Never a Mongo
 * collection. Only the hash is stored.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Counts the request against the account and the IP whether or not the
   * account exists, so a 429 says nothing about who is registered.
   */
  async assertWithinRateLimit(facilityCode: string, email: string, ip: string): Promise<void> {
    const [acct, byIp] = await Promise.all([
      this.bump(`rl:otp:acct:${facilityCode}:${email}`),
      this.bump(`rl:otp:ip:${ip}`),
    ]);
    if (acct > MAX_REQUESTS_PER_ACCOUNT || byIp > MAX_REQUESTS_PER_IP) {
      throw new HttpException('Too many code requests. Wait a few minutes and try again.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async issue(facilityCode: string, email: string): Promise<string> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const key = otpKey(facilityCode, email);
    await this.redis
      .multi()
      .del(key)
      .hset(key, { hash: sha256(code), attempts: 0 })
      .expire(key, this.config.get('OTP_TTL_SECONDS', { infer: true }))
      .exec();
    return code;
  }

  /**
   * True exactly once for the right code. A wrong guess counts an attempt;
   * the fifth burns the code. Consumption is the DEL, so two concurrent
   * correct submissions cannot both succeed.
   */
  async consume(facilityCode: string, email: string, code: string): Promise<boolean> {
    const key = otpKey(facilityCode, email);
    const stored = await this.redis.hget(key, 'hash');
    if (!stored || !/^\d{6}$/.test(code)) return false;

    const a = Buffer.from(sha256(code), 'hex');
    const b = Buffer.from(stored, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      const attempts = await this.redis.hincrby(key, 'attempts', 1);
      if (attempts >= MAX_ATTEMPTS_PER_CODE) await this.redis.del(key);
      return false;
    }
    return (await this.redis.del(key)) === 1;
  }

  /**
   * Backstop for the Redis TTL: removes any OTP or rate-limit key that has
   * somehow lost its expiry (TTL -1), so a code can never live forever.
   */
  async cleanupOrphans(): Promise<number> {
    let removed = 0;
    for (const pattern of ['otp:*', 'rl:otp:*']) {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        for (const key of keys) {
          if ((await this.redis.ttl(key)) === -1) {
            await this.redis.del(key);
            removed += 1;
          }
        }
      } while (cursor !== '0');
    }
    if (removed) this.logger.warn(`removed ${removed} OTP/rate-limit keys that had no expiry`);
    return removed;
  }

  private async bump(key: string): Promise<number> {
    const [[, count]] = (await this.redis.multi().incr(key).expire(key, RATE_WINDOW_SECONDS, 'NX').exec()) as [
      [null, number],
      unknown,
    ];
    return count;
  }
}
