import { S3Client } from '@aws-sdk/client-s3';
import { config } from '../config.js';

const hasR2Config = Boolean(
  config.R2_ACCOUNT_ID
  && config.R2_ACCESS_KEY_ID
  && config.R2_SECRET_ACCESS_KEY
  && config.R2_BUCKET,
);

export const r2 = hasR2Config
  ? new S3Client({
    region: 'auto',
    endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID!,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY!,
    },
  })
  : null;

export const R2_BUCKET = config.R2_BUCKET ?? null;
export const isR2Configured = hasR2Config;
