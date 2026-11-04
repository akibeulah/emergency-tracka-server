import { HttpException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Types } from 'mongoose';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { FakeModel } from '../../test-utils/fake-model';
import { SubmitEnquiryDto } from './dto/enquiries.dto';
import { EnquiriesService } from './enquiries.service';

/** Just the INCR + EXPIRE NX transaction the rate limit uses. */
function fakeRedis() {
  const counts = new Map<string, number>();
  return {
    multi() {
      let key = '';
      const tx = {
        incr(k: string) {
          key = k;
          return tx;
        },
        expire: () => tx,
        exec: async () => {
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return [[null, counts.get(key)], [null, 1]];
        },
      };
      return tx;
    },
  };
}

const valid = {
  reason: 'onboard',
  fullName: '  Ada Example ',
  facilityName: 'Example Clinic',
  email: ' Ada@Example.test ',
  message: 'We would like to join.',
};

async function dto(body: Record<string, unknown>) {
  const d = plainToInstance(SubmitEnquiryDto, body);
  return { d, errors: await validate(d) };
}

function setup() {
  const model = new FakeModel();
  const service = new EnquiriesService(model as never, fakeRedis() as never);
  return { model, service };
}

describe('enquiries (website contact form)', () => {
  it('trims and lower-cases what the sender typed', async () => {
    const { d, errors } = await dto(valid);
    expect(errors).toHaveLength(0);
    expect(d.fullName).toBe('Ada Example');
    expect(d.email).toBe('ada@example.test');
  });

  it('rejects an unknown reason, a bad email and an empty message', async () => {
    const { errors } = await dto({ ...valid, reason: 'sales', email: 'not-an-email', message: '   ' });
    expect(errors.map((e) => e.property).sort()).toEqual(['email', 'message', 'reason']);
  });

  it('saves the enquiry as new, without the IP', async () => {
    const { model, service } = setup();
    const { d } = await dto(valid);
    await expect(service.submit(d, '10.0.0.1')).resolves.toEqual({ received: true });
    expect(model.docs).toHaveLength(1);
    expect(model.docs[0]).toMatchObject({ reason: 'onboard', fullName: 'Ada Example', facilityName: 'Example Clinic' });
    expect(JSON.stringify(model.docs[0])).not.toContain('10.0.0.1');
  });

  it('answers a filled honeypot the same way but saves nothing', async () => {
    const { model, service } = setup();
    const { d } = await dto({ ...valid, website: 'https://spam.test' });
    await expect(service.submit(d, '10.0.0.1')).resolves.toEqual({ received: true });
    expect(model.docs).toHaveLength(0);
  });

  it('allows five an hour from one IP, then 429', async () => {
    const { model, service } = setup();
    const { d } = await dto(valid);
    for (let i = 0; i < 5; i++) await service.submit(d, '10.0.0.1');
    await expect(service.submit(d, '10.0.0.1')).rejects.toMatchObject({ status: 429 });
    await expect(service.submit(d, '10.0.0.2')).resolves.toEqual({ received: true });
    expect(model.docs).toHaveLength(6);
    await expect(service.submit(d, '10.0.0.1')).rejects.toBeInstanceOf(HttpException);
  });

  it('records which admin changed the status, and 404s an unknown id', async () => {
    const { model, service } = setup();
    const { d } = await dto(valid);
    await service.submit(d, '10.0.0.1');
    const admin = { userId: new Types.ObjectId().toHexString() } as AuthUser;
    const updated = await service.setStatus(String(model.docs[0]._id), 'in_progress', admin);
    expect(updated).toMatchObject({ status: 'in_progress' });
    expect(String(updated.statusChange?.by)).toBe(admin.userId);
    await expect(service.setStatus('not-an-id', 'closed', admin)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.setStatus(new Types.ObjectId().toHexString(), 'closed', admin)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
