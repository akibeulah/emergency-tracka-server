import { CanActivate, ExecutionContext, Injectable, mixin, NotFoundException, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.schema';

export type FeatureFlag = 'blood';

const FLAG_ENV: Record<FeatureFlag, keyof Env> = {
  blood: 'FEATURE_BLOOD',
};

export function isFeatureOn(config: ConfigService<Env, true>, flag: FeatureFlag): boolean {
  return Boolean(config.get(FLAG_ENV[flag], { infer: true }));
}

/**
 * A flagged-off module answers 404, as if its routes did not exist (G2: blood
 * is built but hidden from v1).
 */
export function FeatureFlagGuard(flag: FeatureFlag): Type<CanActivate> {
  @Injectable()
  class FlagGuard implements CanActivate {
    constructor(private readonly config: ConfigService<Env, true>) {}
    canActivate(_ctx: ExecutionContext): boolean {
      if (!isFeatureOn(this.config, flag)) throw new NotFoundException();
      return true;
    }
  }
  return mixin(FlagGuard);
}
