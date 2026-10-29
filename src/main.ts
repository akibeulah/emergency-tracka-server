import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { Env } from './config/env.schema';
import { ConfiguredIoAdapter } from './modules/realtime/configured-io.adapter';

async function bootstrap() {
  // rawBody: payment webhooks are verified against the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const origins = config
    .get('CORS_ORIGINS', { infer: true })
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: origins.length ? origins : true, credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, origins));
  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  Logger.log(`Emergency Tracka API on http://localhost:${port}/api (socket.io on the same port)`, 'Bootstrap');
}

void bootstrap();
