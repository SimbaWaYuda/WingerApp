import { ArgumentsHost, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import * as http from 'http';
import { MulterError } from 'multer';
import supertest = require('supertest');
import { ProductImageUploadExceptionFilter } from './product-image-upload.exception-filter';
import { ApprovedSupplierGuard } from '../auth/approved-supplier.guard';
import { AuthUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ProductsController } from './products.controller';
import { ProductsSearchService } from './products-search.service';
import { ProductsService } from './products.service';

const supplier: AuthUser = {
  sub: 'sup-user',
  email: 'supplier@example.com',
  name: 'Supplier',
  role: UserRole.SUPPLIER,
  supplierId: 'sup-1',
};

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe('product image upload HTTP limits', () => {
  let app: INestApplication;
  const addImages = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [
        {
          provide: ProductsService,
          useValue: { addImages },
        },
        {
          provide: ProductsSearchService,
          useValue: {},
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => { user?: AuthUser } };
        }) => {
          context.switchToHttp().getRequest().user = supplier;
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ApprovedSupplierGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    addImages.mockReset();
    addImages.mockResolvedValue({ saved: true });
  });

  it.each([
    ['photo.jpg', 'image/jpeg', jpeg],
    ['photo.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ['photo.webp', 'image/webp', Buffer.from('RIFF')],
    ['photo.gif', 'image/gif', Buffer.from('GIF89a')],
  ])('accepts %s', async (filename, contentType, body) => {
    const response = await supertest(app.getHttpServer())
      .post('/products/prod-1/images')
      .attach('files', body, { filename, contentType })
      .expect(201);

    expect(response.body).toEqual({ saved: true });
    expect(addImages).toHaveBeenCalledTimes(1);
    const saved = addImages.mock.calls[0][1] as Array<{
      originalname: string;
      mimetype: string;
      buffer: Buffer;
    }>;
    expect(saved).toHaveLength(1);
    expect(saved[0].originalname).toBe(filename);
    expect(saved[0].mimetype).toBe(contentType);
    expect(saved[0].buffer.equals(body)).toBe(true);
  });

  it('rejects an unsupported file type and does not keep the request open', async () => {
    const started = Date.now();
    const response = await supertest(app.getHttpServer())
      .post('/products/prod-1/images')
      .attach('files', Buffer.from('not-an-image'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .expect(400);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(JSON.stringify(response.body)).toContain(
      'Only image files are allowed',
    );
    expect(addImages).not.toHaveBeenCalled();
  });

  it('rejects a file larger than 5 MiB', async () => {
    const response = await supertest(app.getHttpServer())
      .post('/products/prod-1/images')
      .attach('files', Buffer.alloc(5 * 1024 * 1024 + 1, 1), {
        filename: 'big.jpg',
        contentType: 'image/jpeg',
      })
      .expect(413);

    expect(JSON.stringify(response.body)).toContain('File too large');
    expect(addImages).not.toHaveBeenCalled();
  });

  it('rejects a ninth file instead of saving it', async () => {
    let pending = supertest(app.getHttpServer()).post('/products/prod-1/images');
    for (let index = 0; index < 9; index += 1) {
      pending = pending.attach('files', jpeg, {
        filename: `photo-${index}.jpg`,
        contentType: 'image/jpeg',
      });
    }
    const started = Date.now();
    const response = await pending.expect(400);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(response.body).toEqual({
      statusCode: 400,
      message: new MulterError('LIMIT_UNEXPECTED_FILE', 'files').message,
      error: 'Bad Request',
    });
    expect(addImages).not.toHaveBeenCalled();
  });

  it('maps LIMIT_UNEXPECTED_FILE to HTTP 400 and leaves other Multer errors unchanged', () => {
    const replies: Array<{ body: unknown; status: number }> = [];
    const filter = new ProductImageUploadExceptionFilter({
      isHeadersSent: () => false,
      reply: (_response: unknown, body: unknown, status: number) => {
        replies.push({ body, status });
      },
      end: () => undefined,
    } as never);
    const host = { getArgByIndex: () => ({}) } as unknown as ArgumentsHost;
    const unexpectedFile = new MulterError('LIMIT_UNEXPECTED_FILE', 'files');

    filter.catch(unexpectedFile, host);
    filter.catch(new MulterError('LIMIT_FILE_COUNT'), host);

    expect(unexpectedFile.code).toBe('LIMIT_UNEXPECTED_FILE');
    expect(replies).toEqual([
      {
        status: 400,
        body: {
          statusCode: 400,
          message: unexpectedFile.message,
          error: 'Bad Request',
        },
      },
      {
        status: 500,
        body: {
          statusCode: 500,
          message: 'Internal server error',
        },
      },
    ]);
  });

  it('still accepts a later upload after the client aborts', async () => {
    const address = app.getHttpServer().address();
    if (address === null || typeof address === 'string') {
      throw new Error('test server is not listening on a port');
    }
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: address.port,
          method: 'POST',
          path: '/products/prod-1/images',
          headers: {
            'content-type': 'multipart/form-data; boundary=abort-boundary',
          },
        },
        () => reject(new Error('aborted upload received a response')),
      );
      req.on('error', () => resolve());
      req.write('--abort-boundary\r\n');
      req.destroy();
    });

    await supertest(app.getHttpServer())
      .post('/products/prod-1/images')
      .attach('files', jpeg, {
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    expect(addImages).toHaveBeenCalledTimes(1);
  });
});
