import { join, resolve } from 'path';

/** Local upload root. Defaults to `<cwd>/uploads`; override with UPLOAD_DIR. */
export function getLocalUploadRoot(): string {
  const configured = process.env.UPLOAD_DIR?.trim();
  if (configured) return resolve(configured);
  return resolve(join(process.cwd(), 'uploads'));
}

export function storageDriver(): 'local' | 's3' {
  return (process.env.STORAGE_DRIVER || 'local').trim().toLowerCase() === 's3'
    ? 's3'
    : 'local';
}
