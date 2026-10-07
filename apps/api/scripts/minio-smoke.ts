/**
 * One-shot S3 create-bucket + put + get against MinIO.
 * Invoked by scripts/minio-smoke.ps1 with STORAGE_DRIVER=s3 env set.
 */
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

async function main() {
  const bucket = process.env.S3_BUCKET?.trim();
  const endpoint = process.env.S3_ENDPOINT?.trim();
  const publicBase = (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();

  if (!bucket || !endpoint || !publicBase || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing S3_* / AWS_* env for MinIO smoke');
  }

  const client = new S3Client({
    region: process.env.S3_REGION?.trim() || 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`Created bucket ${bucket}`);
  }

  const key = `products/smoke/minio-${Date.now()}.txt`;
  const body = Buffer.from(`winger-minio-smoke ${new Date().toISOString()}`);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'text/plain',
    }),
  );

  const got = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const text = await got.Body?.transformToString();
  if (!text?.includes('winger-minio-smoke')) {
    throw new Error('GetObject returned unexpected body');
  }

  const url = `${publicBase}/${key}`;
  console.log(`OK put+get ${key}`);
  console.log(`Object URL: ${url}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
