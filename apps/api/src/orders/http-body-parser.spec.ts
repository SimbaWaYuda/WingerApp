import {
  Body,
  Controller,
  INestApplication,
  Post,
  Req,
} from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Request } from 'express';
import * as http from 'http';
import * as zlib from 'zlib';
import supertest = require('supertest');
import { OrdersService } from './orders.service';
import { StripeService } from './stripe.service';
import { StripeWebhookController } from './stripe-webhook.controller';

@Controller('probe')
class JsonProbeController {
  @Post('json')
  accept(
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>,
  ) {
    return {
      body,
      raw: req.rawBody ? req.rawBody.toString('utf8') : null,
    };
  }
}

describe('HTTP body parser and Stripe raw body', () => {
  let app: INestApplication;
  const constructWebhookEvent = jest.fn();
  const handleStripeEvent = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [JsonProbeController, StripeWebhookController],
      providers: [
        {
          provide: StripeService,
          useValue: { constructWebhookEvent },
        },
        {
          provide: OrdersService,
          useValue: { handleStripeEvent },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    constructWebhookEvent.mockReset();
    handleStripeEvent.mockReset();
    handleStripeEvent.mockResolvedValue({ received: true });
  });

  it('parses a normal JSON request and keeps the raw bytes', async () => {
    const payload = '{"name":"Lamp","qty":1}';
    const response = await supertest(app.getHttpServer())
      .post('/probe/json')
      .set('Content-Type', 'application/json')
      .send(payload)
      .expect(201);

    expect(response.body.body).toEqual({ name: 'Lamp', qty: 1 });
    expect(response.body.raw).toBe(payload);
  });

  it('rejects an oversized JSON body', async () => {
    const payload = JSON.stringify({ blob: 'x'.repeat(120 * 1024) });
    const started = Date.now();
    const response = await supertest(app.getHttpServer())
      .post('/probe/json')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(response.status).toBe(413);
  });

  async function postGzip(body: Buffer) {
    const address = app.getHttpServer().address();
    if (address === null || typeof address === 'string') {
      throw new Error('test server is not listening on a port');
    }
    const started = Date.now();
    const result = await new Promise<{ status: number; raw: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: address.port,
            method: 'POST',
            path: '/probe/json',
            headers: {
              'content-type': 'application/json',
              'content-encoding': 'gzip',
              'content-length': body.length,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                raw: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(body);
      },
    );
    return { ...result, elapsed: Date.now() - started };
  }

  it('inflates a gzip JSON body using the default body parser', async () => {
    await app.listen(0);
    const response = await postGzip(zlib.gzipSync(Buffer.from('{"ok":true}')));
    expect(response.elapsed).toBeLessThan(5000);
    expect(response.status).toBe(201);
    expect(JSON.parse(response.raw).body).toEqual({ ok: true });
  });

  it('rejects trailing bytes after a gzip body without hanging', async () => {
    if (!app.getHttpServer().listening) {
      await app.listen(0);
    }
    const gzip = zlib.gzipSync(Buffer.from('{"ok":true}'));
    const response = await postGzip(
      Buffer.concat([gzip, Buffer.from('TRAILING')]),
    );
    expect(response.elapsed).toBeLessThan(5000);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('passes the exact raw webhook bytes to signature verification', async () => {
    const payload = '{"id":"evt_1","amount":10}';
    constructWebhookEvent.mockReturnValue({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
    });

    const response = await supertest(app.getHttpServer())
      .post('/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'sig_test')
      .send(payload)
      .expect(200);

    expect(response.body).toEqual({ received: true });
    expect(constructWebhookEvent).toHaveBeenCalledTimes(1);
    const raw = constructWebhookEvent.mock.calls[0][0] as Buffer;
    const signature = constructWebhookEvent.mock.calls[0][1];
    expect(Buffer.isBuffer(raw)).toBe(true);
    expect(raw.equals(Buffer.from(payload))).toBe(true);
    expect(signature).toBe('sig_test');
    expect(handleStripeEvent).toHaveBeenCalledTimes(1);
  });

  it('still rejects an invalid Stripe signature before order handling', async () => {
    constructWebhookEvent.mockImplementation(() => {
      throw new Error('Invalid signature');
    });

    await supertest(app.getHttpServer())
      .post('/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'bad_sig')
      .send('{"id":"evt_1"}')
      .expect(400);

    expect(handleStripeEvent).not.toHaveBeenCalled();
  });
});
