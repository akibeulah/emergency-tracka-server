import { ConfigService } from '@nestjs/config';
import { Env, envSchema } from '../../config/env.schema';
import { ConsoleEmailSender, emailSenderFactory, RelayEmailSender, SmtpEmailSender } from './email-sender';

const KEY = 'k'.repeat(64);

function configWith(values: Partial<Record<keyof Env, unknown>>) {
  return { get: (k: keyof Env) => values[k] ?? '' } as unknown as ConfigService<Env, true>;
}

describe('RelayEmailSender', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('posts the message with the API key and accepts 202', async () => {
    const fetchMock = jest.fn(async () => new Response('{"id":"x","status":"queued"}', { status: 202 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const sender = new RelayEmailSender(
      configWith({ MAIL_RELAY_URL: 'https://relay.example.test/', MAIL_RELAY_API_KEY: KEY, MAIL_FROM_NAME: 'Emergency Tracka' }),
    );

    await sender.send('a@b.com', 'Your code', '123456');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://relay.example.test/send');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({ to: 'a@b.com', subject: 'Your code', text: '123456', fromName: 'Emergency Tracka' });
  });

  it('throws when the relay refuses the message', async () => {
    global.fetch = jest.fn(async () => new Response('{"error":"missing or invalid API key"}', { status: 401 })) as unknown as typeof fetch;
    const sender = new RelayEmailSender(configWith({ MAIL_RELAY_URL: 'https://relay.example.test', MAIL_RELAY_API_KEY: KEY }));
    await expect(sender.send('a@b.com', 's', 't')).rejects.toThrow('mail relay answered 401');
  });

  it('is chosen over SMTP when MAIL_RELAY_URL is set', () => {
    expect(emailSenderFactory(configWith({ MAIL_RELAY_URL: 'https://r.test', MAIL_RELAY_API_KEY: KEY, SMTP_HOST: 'mail.test' }))).toBeInstanceOf(RelayEmailSender);
    expect(emailSenderFactory(configWith({ SMTP_HOST: 'mail.test' }))).toBeInstanceOf(SmtpEmailSender);
    expect(emailSenderFactory(configWith({}))).toBeInstanceOf(ConsoleEmailSender);
  });

  it('requires a 32-character key once a relay URL is set', () => {
    const base = { NODE_ENV: 'development', MONGODB_URI: 'mongodb://x/y', REDIS_URL: 'redis://x', JWT_ACCESS_SECRET: 's'.repeat(40) };
    expect(envSchema.validate(base).error).toBeUndefined();
    expect(envSchema.validate({ ...base, MAIL_RELAY_URL: 'https://r.test', MAIL_RELAY_API_KEY: 'short' }).error).toBeDefined();
    expect(envSchema.validate({ ...base, MAIL_RELAY_URL: 'https://r.test', MAIL_RELAY_API_KEY: KEY }).error).toBeUndefined();
  });
});
