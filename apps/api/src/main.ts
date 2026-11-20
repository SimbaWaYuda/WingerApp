import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { assertProductionEnvOrExit } from './config/env.validation';
import { getLocalUploadRoot, storageDriver } from './storage/upload-paths';

// Windows shells often default libpq to WIN1252; supplier names need UTF-8.
if (!process.env.PGCLIENTENCODING) {
  process.env.PGCLIENTENCODING = 'UTF8';
}

assertProductionEnvOrExit();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.enableCors({
    origin: true,
    credentials: true,
  });
  // Always enable so platform SIGTERM can drain Nest (and Prisma) cleanly.
  // Worker lifecycle remains gated by PAYMENT_RECONCILE_WORKER_ENABLED elsewhere.
  app.enableShutdownHooks();
  if (storageDriver() === 'local') {
    const uploadRoot = getLocalUploadRoot();
    app.useStaticAssets(uploadRoot, {
      prefix: '/uploads/',
    });
    // eslint-disable-next-line no-console
    console.log(`Serving uploads from ${uploadRoot}`);
  }
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Winger API listening on http://localhost:${port}`);
}
bootstrap();
