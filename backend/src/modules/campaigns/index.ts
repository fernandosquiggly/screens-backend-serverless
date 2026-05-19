import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { Router, parseBody } from '../../shared/router.js'
import { db, Tables } from '../../shared/db.js'
import { getAuthContext, getDeviceContext } from '../../shared/auth.js'
import { ok, created, badRequest, notFound, unauthorized, noContent } from '../../shared/response.js'
import { campaignKeys, campaignScreenKeys, mediaKeys } from '../../shared/keys.js'
import { presignedDownload, presignedUpload, zipKey, contentKey } from '../../shared/s3.js'
import { createHash } from 'crypto'

const router = new Router()

// ─── Schedule helper ──────────────────────────────────────────────────────────

function isScheduleActive(schedule: { days: number[]; startTime: string; endTime: string; timezone: string } | null): boolean {
  if (!schedule) return true  // no schedule = always active

  const now = new Date()
  const localStr = now.toLocaleString('en-US', { timeZone: schedule.timezone })
  const local = new Date(localStr)

  const day = local.getDay()  // 0=Sun … 6=Sat
  if (schedule.days.length > 0 && !schedule.days.includes(day)) return false

  const [startH, startM] = schedule.startTime.split(':').map(Number)
  const [endH, endM]   = schedule.endTime.split(':').map(Number)
  const currentMinutes = local.getHours() * 60 + local.getMinutes()
  const startMinutes   = startH * 60 + startM
  const endMinutes     = endH   * 60 + endM

  return currentMinutes >= startMinutes && currentMinutes < endMinutes
}

// ─── Device endpoints ─────────────────────────────────────────────────────────

/** GET /device/campaigns/:screenId — list active campaigns for a screen */
router.get('/device/campaigns/:screenId', async (event) => {
  const ctx = await getDeviceContext(event)
  if (!ctx) return unauthorized()

  const screenId = event.pathParameters?.screenId ?? ''

  const res = await db.send(new QueryCommand({
    TableName: Tables.campaigns,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': campaignScreenKeys.pk(screenId) + '_SCREEN',
      ':prefix': 'CAMPAIGN#',
    },
  }))

  const campaignIds = (res.Items ?? []).map(i => i.campaignId as string)
  const campaigns = await Promise.all(
    campaignIds.map(id =>
      db.send(new GetCommand({
        TableName: Tables.campaigns,
        Key: { pk: campaignKeys.pk(ctx.tenantId), sk: campaignKeys.sk(id) },
      })).then(r => r.Item)
    )
  )

  const active = campaigns.filter(c => c && c.isActive && isScheduleActive(c.schedule ?? null))
  return ok({ results: active.map(c => ({ name: c!.name, content_hash: c!.contentHash })) })
})

/** GET /device/campaigns/:screenId/checksum — hash of campaign list for change detection */
router.get('/device/campaigns/:screenId/checksum', async (event) => {
  const ctx = await getDeviceContext(event)
  if (!ctx) return unauthorized()

  const screenId = event.pathParameters?.screenId ?? ''

  const res = await db.send(new QueryCommand({
    TableName: Tables.campaigns,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `SCREENASSIGN#${screenId}`,
      ':prefix': 'CAMPAIGN#',
    },
  }))

  const ids = (res.Items ?? []).map(i => i.campaignId as string)
  const campaigns = (await Promise.all(
    ids.map(id =>
      db.send(new GetCommand({
        TableName: Tables.campaigns,
        Key: { pk: campaignKeys.pk(ctx.tenantId), sk: campaignKeys.sk(id) },
      })).then(r => r.Item)
    )
  )).filter(c => c?.isActive)

  const payload = campaigns
    .sort((a, b) => (a!.name as string).localeCompare(b!.name as string))
    .map(c => `${c!.name}:${c!.contentHash}`)
    .join(',')

  const hash = createHash('sha256').update(payload).digest('hex')
  const lastUpdated = campaigns.reduce<string | null>((max, c) => {
    const u = c!.updatedAt as string
    return max == null || u > max ? u : max
  }, null)

  return ok({ hash, lastUpdated, count: campaigns.length })
})

/** GET /device/campaigns/presigned/:zipName — presigned download URL for a campaign ZIP */
router.get('/device/campaigns/presigned/:zipName', async (event) => {
  const ctx = await getDeviceContext(event)
  if (!ctx) return unauthorized()

  const zipName = (event.pathParameters?.zipName ?? '').replace('.zip', '')

  // Find campaign by name
  const res = await db.send(new QueryCommand({
    TableName: Tables.campaigns,
    IndexName: 'GSI1',
    KeyConditionExpression: 'gsi1pk = :pk',
    FilterExpression: '#n = :name AND isActive = :a',
    ExpressionAttributeNames: { '#n': 'name' },
    ExpressionAttributeValues: {
      ':pk': `CAMPAIGNS#${ctx.tenantId}`,
      ':name': zipName,
      ':a': true,
    },
  }))

  const campaign = res.Items?.[0]
  if (!campaign) return notFound('Campaign not found')

  // If s3Key is already a full URL (dev mode), return it directly
  if (campaign.s3Key.startsWith('http')) {
    return ok({ url: campaign.s3Key })
  }

  const url = await presignedDownload(campaign.s3Key)
  return ok({ url })
})

// ─── Dashboard endpoints ───────────────────────────────────────────────────────

/** GET /campaigns — list all campaigns */
router.get('/campaigns', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const res = await db.send(new QueryCommand({
    TableName: Tables.campaigns,
    IndexName: 'GSI1',
    KeyConditionExpression: 'gsi1pk = :pk',
    ExpressionAttributeValues: { ':pk': `CAMPAIGNS#${auth.tenantId}` },
  }))

  // Enrich with assigned screen IDs
  const campaigns = await Promise.all((res.Items ?? []).map(async c => {
    const assigns = await db.send(new QueryCommand({
      TableName: Tables.campaigns,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `SCREENASSIGN_BY_CAMPAIGN#${c.campaignId}`,
        ':prefix': 'SCREEN#',
      },
    }))
    return { ...c, screenIds: (assigns.Items ?? []).map(a => a.screenId) }
  }))

  return ok(campaigns)
})

/** POST /campaigns — create campaign */
router.post('/campaigns', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const body = parseBody<{ name: string; s3Key?: string; screenIds?: string[] }>(event)
  if (!body.name) return badRequest('name is required')

  const campaignId = randomUUID()
  const now = new Date().toISOString()

  await db.send(new PutCommand({
    TableName: Tables.campaigns,
    Item: {
      pk: campaignKeys.pk(auth.tenantId),
      sk: campaignKeys.sk(campaignId),
      gsi1pk: `CAMPAIGNS#${auth.tenantId}`,
      gsi1sk: now,
      campaignId,
      tenantId: auth.tenantId,
      name: body.name,
      s3Key: body.s3Key ?? '',
      contentHash: '',
      isActive: true,
      createdAt: now,
      updatedAt: now,
    },
  }))

  if (body.screenIds?.length) {
    await assignScreens(campaignId, auth.tenantId, body.screenIds)
  }

  return created({ campaignId, name: body.name, tenantId: auth.tenantId, isActive: true, createdAt: now })
})

/** PATCH /campaigns/:campaignId — update campaign */
router.patch('/campaigns/:campaignId', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const campaignId = event.pathParameters?.campaignId ?? ''
  const body = parseBody<{ name?: string; s3Key?: string; isActive?: boolean; schedule?: unknown }>(event)

  const expressions: string[] = ['updatedAt = :now']
  const vals: Record<string, unknown> = { ':now': new Date().toISOString() }

  if (body.name     !== undefined) { expressions.push('name = :n');     vals[':n'] = body.name }
  if (body.s3Key    !== undefined) { expressions.push('s3Key = :k');    vals[':k'] = body.s3Key }
  if (body.isActive !== undefined) { expressions.push('isActive = :a'); vals[':a'] = body.isActive }
  if ('schedule' in body)          { expressions.push('schedule = :s'); vals[':s'] = body.schedule ?? null }

  const res = await db.send(new UpdateCommand({
    TableName: Tables.campaigns,
    Key: { pk: campaignKeys.pk(auth.tenantId), sk: campaignKeys.sk(campaignId) },
    UpdateExpression: `SET ${expressions.join(', ')}`,
    ExpressionAttributeValues: vals,
    ReturnValues: 'ALL_NEW',
  }))

  return ok(res.Attributes)
})

/** DELETE /campaigns/:campaignId — archive campaign */
router.delete('/campaigns/:campaignId', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const campaignId = event.pathParameters?.campaignId ?? ''
  await db.send(new UpdateCommand({
    TableName: Tables.campaigns,
    Key: { pk: campaignKeys.pk(auth.tenantId), sk: campaignKeys.sk(campaignId) },
    UpdateExpression: 'SET isActive = :f',
    ExpressionAttributeValues: { ':f': false },
  }))

  return noContent()
})

/** POST /campaigns/:campaignId/assign — assign screens */
router.post('/campaigns/:campaignId/assign', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const campaignId = event.pathParameters?.campaignId ?? ''
  const body = parseBody<{ screenIds: string[] }>(event)

  // Remove old assignments
  const old = await db.send(new QueryCommand({
    TableName: Tables.campaigns,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `SCREENASSIGN_BY_CAMPAIGN#${campaignId}`,
      ':prefix': 'SCREEN#',
    },
  }))
  await Promise.all((old.Items ?? []).map(item =>
    db.send(new DeleteCommand({
      TableName: Tables.campaigns,
      Key: { pk: item.pk, sk: item.sk },
    }))
  ))

  await assignScreens(campaignId, auth.tenantId, body.screenIds ?? [])
  return ok({ campaignId, screenIds: body.screenIds ?? [] })
})

async function assignScreens(campaignId: string, tenantId: string, screenIds: string[]) {
  await Promise.all(screenIds.map(screenId =>
    db.send(new PutCommand({
      TableName: Tables.campaigns,
      Item: {
        // Forward: by screen → campaigns
        pk: `SCREENASSIGN#${screenId}`,
        sk: `CAMPAIGN#${campaignId}`,
        campaignId,
        screenId,
        tenantId,
      },
    })).then(() =>
      db.send(new PutCommand({
        TableName: Tables.campaigns,
        Item: {
          // Reverse: by campaign → screens
          pk: `SCREENASSIGN_BY_CAMPAIGN#${campaignId}`,
          sk: `SCREEN#${screenId}`,
          campaignId,
          screenId,
          tenantId,
        },
      }))
    )
  ))
}

// ─── Campaign media ────────────────────────────────────────────────────────────

/** GET /campaigns/:campaignId/media — list media files */
router.get('/campaigns/:campaignId/media', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const campaignId = event.pathParameters?.campaignId ?? ''
  const res = await db.send(new QueryCommand({
    TableName: Tables.media,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': mediaKeys.pk(campaignId),
      ':prefix': 'MEDIA#',
    },
  }))

  const items = await Promise.all((res.Items ?? []).map(async item => ({
    ...item,
    url: await presignedDownload(item.s3Key),
  })))

  return ok(items.sort((a, b) => ((a as any).order as number) - ((b as any).order as number)))
})

/** POST /campaigns/:campaignId/media/presigned — get presigned upload URL */
router.post('/campaigns/:campaignId/media/presigned', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const campaignId = event.pathParameters?.campaignId ?? ''
  const body = parseBody<{ filename: string; contentType: string; sizeBytes: number }>(event)

  if (!body.filename || !body.contentType) return badRequest('filename and contentType required')

  const mediaId = randomUUID()
  const ext = body.filename.split('.').pop() ?? 'bin'
  const s3Key = contentKey('campaigns', auth.tenantId, mediaId, ext)

  const uploadUrl = await presignedUpload(s3Key, body.contentType)
  const now = new Date().toISOString()

  // Reserve the media slot — confirmed after upload
  await db.send(new PutCommand({
    TableName: Tables.media,
    Item: {
      pk: mediaKeys.pk(campaignId),
      sk: mediaKeys.sk(mediaId),
      mediaId,
      campaignId,
      tenantId: auth.tenantId,
      filename: body.filename,
      s3Key,
      mediaType: body.contentType.startsWith('video') ? 'video' : 'image',
      order: 9999,
      sizeBytes: body.sizeBytes ?? 0,
      confirmed: false,
      createdAt: now,
    },
  }))

  return ok({ mediaId, uploadUrl, s3Key })
})

/** POST /campaigns/:campaignId/media/:mediaId/confirm — confirm upload completed */
router.post('/campaigns/:campaignId/media/:mediaId/confirm', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const { campaignId, mediaId } = event.pathParameters ?? {}

  // Get current highest order
  const existing = await db.send(new QueryCommand({
    TableName: Tables.media,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': mediaKeys.pk(campaignId!),
      ':prefix': 'MEDIA#',
    },
    ProjectionExpression: '#o',
    ExpressionAttributeNames: { '#o': 'order' },
  }))
  const maxOrder = (existing.Items ?? []).reduce((max, i) => Math.max(max, i.order as number), -1)

  const res = await db.send(new UpdateCommand({
    TableName: Tables.media,
    Key: { pk: mediaKeys.pk(campaignId!), sk: mediaKeys.sk(mediaId!) },
    UpdateExpression: 'SET confirmed = :t, #o = :ord',
    ExpressionAttributeNames: { '#o': 'order' },
    ExpressionAttributeValues: { ':t': true, ':ord': maxOrder + 1 },
    ReturnValues: 'ALL_NEW',
  }))

  return ok(res.Attributes)
})

/** PATCH /campaigns/:campaignId/media/:mediaId — reorder */
router.patch('/campaigns/:campaignId/media/:mediaId', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const { campaignId, mediaId } = event.pathParameters ?? {}
  const body = parseBody<{ order: number }>(event)

  const res = await db.send(new UpdateCommand({
    TableName: Tables.media,
    Key: { pk: mediaKeys.pk(campaignId!), sk: mediaKeys.sk(mediaId!) },
    UpdateExpression: 'SET #o = :ord',
    ExpressionAttributeNames: { '#o': 'order' },
    ExpressionAttributeValues: { ':ord': body.order },
    ReturnValues: 'ALL_NEW',
  }))

  return ok(res.Attributes)
})

/** DELETE /campaigns/:campaignId/media/:mediaId — delete media */
router.delete('/campaigns/:campaignId/media/:mediaId', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const { campaignId, mediaId } = event.pathParameters ?? {}
  await db.send(new DeleteCommand({
    TableName: Tables.media,
    Key: { pk: mediaKeys.pk(campaignId!), sk: mediaKeys.sk(mediaId!) },
  }))

  return noContent()
})

/** POST /campaigns/:campaignId/publish — trigger async ZIP build via SQS */
router.post('/campaigns/:campaignId/publish', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const campaignId = event.pathParameters?.campaignId ?? ''

  // Enqueue async ZIP packaging job
  const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs')
  const sqs = new SQSClient({})
  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.PUBLISH_QUEUE_URL!,
    MessageBody: JSON.stringify({ campaignId, tenantId: auth.tenantId }),
  }))

  return ok({ status: 'queued', campaignId })
})

export const handler = (event: APIGatewayProxyEventV2) => router.handle(event)
