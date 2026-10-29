import { Controller, Get, Inject, Res } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Response } from 'express';
import Redis from 'ioredis';
import { Connection } from 'mongoose';
import { REDIS } from '../../config/redis.module';

/** Liveness + dependencies. 503 when Mongo or Redis is unreachable. */
@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly mongo: Connection,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const mongo = this.mongo.readyState === 1 ? 'up' : 'down';
    const redis = await Promise.race([
      this.redis.ping().then(() => 'up' as const),
      new Promise<'down'>((r) => setTimeout(() => r('down'), 1_000)),
    ]).catch(() => 'down' as const);
    const ok = mongo === 'up' && redis === 'up';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', mongo, redis, time: new Date().toISOString() };
  }
}
