import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PLATFORM_FACILITY_CODE, PUBLIC_FACILITY_CODE } from '../../common/permissions';
import { Env } from '../../config/env.schema';
import { Facility, FacilityDocument } from '../facilities/schemas/facility.schema';
import { EMAIL_SENDER, EmailSender } from '../notifications/email-sender';
import { SMS_SENDER, SmsSender } from '../notifications/sms-sender';
import { User, UserDocument } from '../users/schemas/user.schema';
import { OtpService } from './otp.service';
import { SessionsService, TokenPair } from './sessions.service';

export const NEUTRAL_OTP_MESSAGE = 'If that account exists, a sign-in code is on its way. It expires in 5 minutes.';
const WRONG_CODE = 'That code is wrong or has expired. Request a new one.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Facility.name) private readonly facilities: Model<FacilityDocument>,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    private readonly otp: OtpService,
    private readonly sessions: SessionsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Same answer whether or not the account exists (no enumeration). */
  async requestOtp(
    facilityCode: string | undefined,
    email: string,
    ip: string,
  ): Promise<{ message: string; devCode?: string }> {
    const fc = facilityCode ?? PUBLIC_FACILITY_CODE;
    await this.otp.assertWithinRateLimit(fc, email, ip);

    const user = await this.findLoginableUser(fc, email);
    if (!user) return { message: NEUTRAL_OTP_MESSAGE };

    const code = await this.otp.issue(fc, email);
    const text = `Your Emergency Tracka sign-in code is ${code}. It expires in 5 minutes.`;
    if (user.phone) await this.sms.send(user.phone, text);
    // Not awaited: neither SMTP latency nor a mail failure may change the answer (no enumeration).
    void this.email
      .send(user.email, `Your Emergency Tracka sign-in code: ${code}`, `${text}\n\nIf you did not ask for this code, ignore this email.`)
      .catch((err: Error) => this.logger.warn(`email OTP to account ${String(user._id)} failed: ${err.message}`));
    if (this.config.get('NODE_ENV', { infer: true }) !== 'production') {
      this.logger.debug(`[dev] OTP for ${fc}/${email}: ${code}`);
    }
    return this.config.get('OTP_DEV_ECHO', { infer: true })
      ? { message: NEUTRAL_OTP_MESSAGE, devCode: code }
      : { message: NEUTRAL_OTP_MESSAGE };
  }

  async verifyOtp(
    facilityCode: string | undefined,
    email: string,
    code: string,
    deviceId: string,
    ip?: string,
  ): Promise<TokenPair & { user: ReturnType<AuthService['publicUser']> }> {
    const fc = facilityCode ?? PUBLIC_FACILITY_CODE;
    if (!(await this.otp.consume(fc, email, code))) throw new UnauthorizedException(WRONG_CODE);

    // Re-checked after the code: the account or facility may have been suspended in between.
    const user = await this.findLoginableUser(fc, email);
    if (!user) throw new UnauthorizedException(WRONG_CODE);

    const tokens = await this.sessions.create(user, deviceId, ip);
    return { ...tokens, user: this.publicUser(user) };
  }

  refresh(refreshToken: string) {
    return this.sessions.refresh(refreshToken, (id) => this.findActiveUserById(id));
  }

  logout(sessionId: string) {
    return this.sessions.revoke(sessionId);
  }

  async me(userId: string) {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException();
    return this.publicUser(user);
  }

  /** Other accounts on the same email, for the header switcher (2-3). Each still needs its own OTP. */
  async accountsFor(userId: string) {
    const user = await this.users.findById(userId, { email: 1 }).lean();
    if (!user) return [];
    const accounts = await this.users
      .find({ email: user.email, status: 'active' }, { facilityCode: 1, role: 1, name: 1, permissions: 1 })
      .lean();
    const codes = accounts.map((a) => a.facilityCode);
    const facilities = await this.facilities
      .find({ facilityCode: { $in: codes } }, { facilityCode: 1, name: 1, displayCode: 1 })
      .lean();
    const byCode = new Map(facilities.map((f) => [f.facilityCode, f]));
    return accounts.map((a) => ({
      facilityCode: a.facilityCode,
      facilityName: byCode.get(a.facilityCode)?.name ?? null,
      displayCode: byCode.get(a.facilityCode)?.displayCode ?? null,
      role: a.role,
      permissions: a.permissions,
      current: String(a._id) === userId,
    }));
  }

  private async findLoginableUser(facilityCode: string, email: string): Promise<UserDocument | null> {
    const user = await this.users.findOne({ facilityCode, email, status: 'active' });
    if (!user) return null;
    if (facilityCode === PUBLIC_FACILITY_CODE || facilityCode === PLATFORM_FACILITY_CODE) return user;
    const facility = await this.facilities.exists({ facilityCode, status: 'verified' });
    return facility ? user : null;
  }

  private async findActiveUserById(id: Types.ObjectId): Promise<UserDocument | null> {
    const user = await this.users.findById(id);
    if (!user) return null;
    return this.findLoginableUser(user.facilityCode, user.email);
  }

  private publicUser(user: UserDocument) {
    return {
      id: String(user._id),
      email: user.email,
      name: user.name ?? null,
      facilityCode: user.facilityCode,
      role: user.role,
      permissions: user.permissions,
    };
  }
}
