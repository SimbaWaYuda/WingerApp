import { homedir } from 'os';
import { join, resolve } from 'path';

/**
 * Local upload root. UPLOAD_DIR wins when set.
 * Otherwise use the home-folder store, the same place boot.ps1 and dev.ps1 use,
 * so a manual `npm run start:dev` does not write into apps/api/uploads.
 */
export function getLocalUploadRoot(): string {
  const configured = process.env.UPLOAD_DIR?.trim();
  if (configured) return resolve(configured);
  return resolve(join(homedir(), 'WingerData', 'uploads'));
}

export function storageDriver(): 'local' | 's3' {
  return (process.env.STORAGE_DRIVER || 'local').trim().toLowerCase() === 's3'
    ? 's3'
    : 'local';
}
