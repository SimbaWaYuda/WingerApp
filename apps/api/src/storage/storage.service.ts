import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { getLocalUploadRoot, storageDriver } from './upload-paths';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly driver = storageDriver();
  private readonly localRoot = getLocalUploadRoot();
  private s3: S3Client | null = null;
  private bucket = '';
  private publicBase = '';

  onModuleInit() {
    if (this.driver === 'local') {
      this.logger.log(`Storage: local → ${this.localRoot}`);
      return;
    }

    this.bucket = process.env.S3_BUCKET?.trim() || '';
    this.publicBase = (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (!this.bucket || !this.publicBase) {
      throw new Error(
        'STORAGE_DRIVER=s3 requires S3_BUCKET and S3_PUBLIC_BASE_URL',
      );
    }

    this.s3 = new S3Client({
      region: process.env.S3_REGION?.trim() || 'auto',
      endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
      forcePathStyle:
        (process.env.S3_FORCE_PATH_STYLE || 'true').toLowerCase() !== 'false',
      credentials:
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            }
          : undefined,
    });
    this.logger.log(`Storage: s3 → ${this.publicBase} (bucket ${this.bucket})`);
  }

  servesLocalStatic(): boolean {
    return this.driver === 'local';
  }

  localStaticRoot(): string {
    return this.localRoot;
  }

  /**
   * Persist a product image and return the public URL stored in the DB
   * (relative `/uploads/...` for local, absolute HTTPS for S3).
   */
  async putProductImage(
    productId: string,
    filename: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string> {
    const key = `products/${productId}/${filename}`;
    if (this.driver === 'local') {
      const fullPath = join(this.localRoot, key);
      await fs.mkdir(dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, buffer);
      return `/uploads/${key}`;
    }

    if (!this.s3) throw new Error('S3 client not initialised');
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream',
      }),
    );
    return `${this.publicBase}/${key}`;
  }

  async deleteStoredUrl(url: string): Promise<void> {
    if (!url) return;

    if (url.startsWith('/uploads/')) {
      const relative = url.replace(/^\/uploads\//, '');
      try {
        await fs.unlink(join(this.localRoot, relative));
      } catch {
        // Already gone.
      }
      return;
    }

    if (this.driver === 's3' && this.publicBase && url.startsWith(this.publicBase)) {
      const key = url.slice(this.publicBase.length).replace(/^\//, '');
      if (!key || !this.s3) return;
      try {
        await this.s3.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        );
      } catch {
        // Ignore delete races.
      }
    }
  }
}
