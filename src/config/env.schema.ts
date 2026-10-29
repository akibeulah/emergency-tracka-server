import * as Joi from 'joi';

/**
 * Every environment variable the server reads. Validated once at boot so a
 * missing secret fails the deploy, not the first emergency.
 */
export const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  CORS_ORIGINS: Joi.string().allow('').default(''),

  MONGODB_URI: Joi.string().uri({ scheme: ['mongodb', 'mongodb+srv'] }).required(),
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),

  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL_SECONDS: Joi.number().integer().min(60).default(900),
  REFRESH_TTL_DAYS: Joi.number().integer().min(1).default(30),

  OTP_TTL_SECONDS: Joi.number().integer().min(60).default(300),
  // Never in production: it would hand the code to whoever asked for it.
  OTP_DEV_ECHO: Joi.boolean()
    .default(false)
    .when('NODE_ENV', { is: 'production', then: Joi.valid(false) }),

  WAVE_TIMEOUT_CRITICAL_SECONDS: Joi.number().integer().min(10).default(180),
  WAVE_TIMEOUT_DEFAULT_SECONDS: Joi.number().integer().min(10).default(600),
  MATRON_AUTO_CONFIRM_SECONDS: Joi.number().integer().min(10).default(180),
  RECONCILIATION_INTERVAL_SECONDS: Joi.number().integer().min(5).default(60),

  ROSTER_ENFORCEMENT: Joi.string().valid('when_present', 'strict').default('when_present'),

  FEATURE_BLOOD: Joi.boolean().default(false),

  PAYSTACK_SECRET_KEY: Joi.string().allow('').default(''),
  PAYSTACK_CALLBACK_URL: Joi.string().allow('').default(''),
  PROXY_URL: Joi.string().allow('').default(''),
  PROXY_USERNAME: Joi.string().allow('').default(''),
  PROXY_PASSWORD: Joi.string().allow('').default(''),

  // Sign-in codes by email. Blank SMTP_HOST = log to the console instead.
  SMTP_HOST: Joi.string().allow('').default(''),
  SMTP_PORT: Joi.number().port().default(587),
  SMTP_USER: Joi.string().allow('').default(''),
  SMTP_PASSWORD: Joi.string().allow('').default(''),
  SMTP_FROM: Joi.string().allow('').default(''),
});

export interface Env {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  CORS_ORIGINS: string;
  MONGODB_URI: string;
  REDIS_URL: string;
  JWT_ACCESS_SECRET: string;
  JWT_ACCESS_TTL_SECONDS: number;
  REFRESH_TTL_DAYS: number;
  OTP_TTL_SECONDS: number;
  OTP_DEV_ECHO: boolean;
  WAVE_TIMEOUT_CRITICAL_SECONDS: number;
  WAVE_TIMEOUT_DEFAULT_SECONDS: number;
  MATRON_AUTO_CONFIRM_SECONDS: number;
  RECONCILIATION_INTERVAL_SECONDS: number;
  ROSTER_ENFORCEMENT: 'when_present' | 'strict';
  FEATURE_BLOOD: boolean;
  PAYSTACK_SECRET_KEY: string;
  PAYSTACK_CALLBACK_URL: string;
  PROXY_URL: string;
  PROXY_USERNAME: string;
  PROXY_PASSWORD: string;
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_USER: string;
  SMTP_PASSWORD: string;
  SMTP_FROM: string;
}
