import type { SQSHandler, SQSBatchResponse } from 'aws-lambda'
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import JSZip from 'jszip'
import { createHash } from 'crypto'
import { db, Tables } from '../../shared/db.js'
import { s3, Buckets, zipKey } from '../../shared/s3.js'
import { campaignKeys, mediaKeys } from '../../shared/keys.js'

export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const failures: { itemIdentifier: string }[] = []

  for (const record of event.Records) {
    try {
      const { campaignId, tenantId } = JSON.parse(record.body) as { campaignId: string; tenantId: string }

      // Fetch media files for this campaign
      const mediaRes = await db.send(new QueryCommand({
        TableName: Tables.media,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        FilterExpression: 'confirmed = :t',
        ExpressionAttributeValues: {
          ':pk': mediaKeys.pk(campaignId),
          ':prefix': 'MEDIA#',
          ':t': true,
        },
      }))

      const files = (mediaRes.Items ?? []).sort((a, b) => (a.order as number) - (b.order as number))
      if (!files.length) continue

      // Build ZIP in memory
      const zip = new JSZip()
      const hasher = createHash('sha256')

      for (const file of files) {
        const obj = await s3.send(new GetObjectCommand({
          Bucket: Buckets.media,
          Key: file.s3Key as string,
        }))
        const bytes = await obj.Body!.transformToByteArray()
        zip.file(file.filename as string, bytes)
        hasher.update(bytes)
      }

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
      const contentHash = hasher.digest('hex').slice(0, 16)
      const key = zipKey(tenantId, campaignId)

      // Upload ZIP to S3
      await s3.send(new PutObjectCommand({
        Bucket: Buckets.media,
        Key: key,
        Body: zipBuffer,
        ContentType: 'application/zip',
      }))

      // Update campaign with new s3Key and contentHash
      await db.send(new UpdateCommand({
        TableName: Tables.campaigns,
        Key: { pk: campaignKeys.pk(tenantId), sk: campaignKeys.sk(campaignId) },
        UpdateExpression: 'SET s3Key = :key, contentHash = :hash, updatedAt = :now',
        ExpressionAttributeValues: {
          ':key': key,
          ':hash': contentHash,
          ':now': new Date().toISOString(),
        },
      }))
    } catch (err) {
      console.error('Publish worker failed for record', record.messageId, err)
      failures.push({ itemIdentifier: record.messageId })
    }
  }

  return { batchItemFailures: failures }
}
