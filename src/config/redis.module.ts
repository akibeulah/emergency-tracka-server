import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Env } from './env.schema';

export const REDIS = Symbol('REDIS');

/** Parses REDIS_URL into the connection options BullMQ also needs. */
export function redisConnectionOptions(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    // BullMQ requires this to be null for its blocking connections.
    maxRetriesPerRequest: null,
  };
}

@Injectable()
class RedisCloser implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onApplicationShutdown() {
    await this.redis.quit().catch(() => undefined);
  }
}

/** One shared ioredis client for OTPs, rate limits and the active-session set. */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Redis(redisConnectionOptions(config.get('REDIS_URL', { infer: true }))),
    },
    RedisCloser,
  ],
  exports: [REDIS],
})
export class RedisModule {}
