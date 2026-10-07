import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { getLocalUploadRoot, storageDriver } from './storage/upload-paths';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({
    origin: true,
    credentials: true,
  });
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
