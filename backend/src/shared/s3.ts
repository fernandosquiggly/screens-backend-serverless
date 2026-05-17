import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createHash } from 'crypto'

export const s3 = new S3Client({})

export const Buckets = {
  media: process.env.MEDIA_BUCKET!,
} as const

/** Generate a presigned download URL (default 1 hour). */
export const presignedDownload = (key: string, expiresIn = 3600) =>
  getSignedUrl(s3, new GetObjectCommand({ Bucket: Buckets.media, Key: key }), { expiresIn })

/** Generate a presigned upload URL (default 15 minutes). */
export const presignedUpload = (key: string, contentType: string, expiresIn = 900) =>
  getSignedUrl(s3, new PutObjectCommand({ Bucket: Buckets.media, Key: key, ContentType: contentType }), { expiresIn })

/** Content-addressed key: {module}/{tenantId}/content/{sha256}.{ext} */
export const contentKey = (module: string, tenantId: string, sha256: string, ext: string) =>
  `${module}/${tenantId}/content/${sha256}.${ext}`

/** Campaign ZIP key */
export const zipKey = (tenantId: string, campaignId: string) =>
  `campaigns/${tenantId}/zips/${campaignId}.zip`

export const sha256 = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex')
