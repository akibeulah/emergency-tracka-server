import { HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import Redis from 'ioredis';
import { isValidObjectId, Model, Types } from 'mongoose';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { REDIS } from '../../config/redis.module';
import { SubmitEnquiryDto } from './dto/enquiries.dto';
import { Enquiry, EnquiryDocument, EnquiryStatus } from './schemas/enquiry.schema';

const RATE_WINDOW_SECONDS = 60 * 60;
const MAX_PER_IP = 5;

/** What the website gets back, saved or not, so a bot cannot tell it was caught. */
const RECEIVED = { received: true } as const;

@Injectable()
export class EnquiriesService {
  constructor(
    @InjectModel(Enquiry.name) private readonly model: Model<EnquiryDocument>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** The IP only counts towards the limit in Redis; it is never stored with the enquiry. */
  async submit(dto: SubmitEnquiryDto, ip: string) {
    if (dto.website) return RECEIVED;
    if ((await this.bump(`rl:enquiry:ip:${ip}`)) > MAX_PER_IP) {
      throw new HttpException(
        'Too many messages from this connection. Try again in an hour, or message us on LinkedIn.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.model.create({
      reason: dto.reason,
      fullName: dto.fullName,
      facilityName: dto.facilityName || undefined,
      email: dto.email,
      message: dto.message,
    });
    return RECEIVED;
  }

  list(status?: EnquiryStatus) {
    return this.model
      .find(status ? { status } : {})
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
  }

  async setStatus(id: string, status: EnquiryStatus, admin: AuthUser) {
    const updated = isValidObjectId(id)
      ? await this.model
          .findOneAndUpdate(
            { _id: id },
            { $set: { status, statusChange: { by: new Types.ObjectId(admin.userId), at: new Date() } } },
            { new: true },
          )
          .lean()
      : null;
    if (!updated) throw new NotFoundException('No such enquiry.');
    return updated;
  }

  private async bump(key: string): Promise<number> {
    const [[, count]] = (await this.redis.multi().incr(key).expire(key, RATE_WINDOW_SECONDS, 'NX').exec()) as [
      [null, number],
      unknown,
    ];
    return count;
  }
}
