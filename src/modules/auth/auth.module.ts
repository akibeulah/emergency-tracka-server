import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { Env } from '../../config/env.schema';
import { Facility, FacilitySchema } from '../facilities/schemas/facility.schema';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { RosterGuard } from './guards/roster.guard';
import { JwtStrategy } from './jwt.strategy';
import { OtpService } from './otp.service';
import { Session, SessionSchema } from './schemas/session.schema';
import { SessionsService } from './sessions.service';

/**
 * Global so every module's controllers can use the three guards, and the
 * facilities/users modules can revoke sessions.
 */
@Global()
@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
      }),
    }),
    MongooseModule.forFeature([
      { name: Session.name, schema: SessionSchema },
      { name: Facility.name, schema: FacilitySchema },
    ]),
  ],
  controllers: [AuthController],
  providers: [AuthService, OtpService, SessionsService, JwtStrategy, JwtAuthGuard, PermissionsGuard, RosterGuard],
  exports: [JwtModule, SessionsService, OtpService, JwtAuthGuard, PermissionsGuard, RosterGuard, UsersModule],
})
export class AuthModule {}
