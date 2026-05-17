import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { PutCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'crypto'
import QRCode from 'qrcode'
import { Router, parseBody } from '../../shared/router.js'
import { db, Tables } from '../../shared/db.js'
import { getAuthContext } from '../../shared/auth.js'
import { ok, created, badRequest, notFound, unauthorized, conflict, gone } from '../../shared/response.js'
import { pairingKeys, screenKeys, deviceTokenKeys } from '../../shared/keys.js'

const router = new Router()
const PIN_TTL_SECONDS = 300

function generatePin(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

/** POST /pairing/request — Android TV generates PIN (no auth required) */
router.post('/pairing/request', async (event) => {
  // Cleanup expired PINs is handled by DynamoDB TTL
  const pin = generatePin()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + PIN_TTL_SECONDS * 1000)

  const qrData = JSON.stringify({ pin, action: 'pair_screen' })
  const qrBase64 = await QRCode.toDataURL(qrData).then((url: string) => url.split(',')[1])

  await db.send(new PutCommand({
    TableName: Tables.pairing,
    Item: {
      pk: pairingKeys.pk(pin),
      sk: pairingKeys.sk(),
      pin,
      deviceType: 'android_tv',
      tenantId: null,
      screenId: null,
      screenName: null,
      token: null,
      expiresAt: expiresAt.toISOString(),
      pairedAt: null,
      createdAt: now.toISOString(),
      ttl: Math.floor(expiresAt.getTime() / 1000),  // DynamoDB TTL (Unix seconds)
    },
  }))

  return created({ pin, qrBase64, expiresIn: PIN_TTL_SECONDS, expiresAt: expiresAt.toISOString() })
})

/** POST /pairing/confirm — authenticated user links PIN to their account */
router.post('/pairing/confirm', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const body = parseBody<{ pin: string; screenName: string }>(event)
  if (!body.pin || !body.screenName) return badRequest('pin and screenName are required')

  const res = await db.send(new GetCommand({
    TableName: Tables.pairing,
    Key: { pk: pairingKeys.pk(body.pin), sk: pairingKeys.sk() },
  }))

  const pairing = res.Item
  if (!pairing || pairing.pairedAt) return notFound('Invalid or already used PIN.')
  if (new Date(pairing.expiresAt as string) < new Date()) return gone('PIN has expired.')

  // Check screen name uniqueness
  const nameCheck = await db.send(new GetCommand({
    TableName: Tables.screens,
    Key: { pk: `TENANT#${auth.tenantId}`, sk: `SCREENNAME#${body.screenName}` },
  }))
  if (nameCheck.Item) return conflict('A screen with that name already exists.')

  const screenId = randomUUID()
  const token = randomUUID().replace(/-/g, '')
  const now = new Date().toISOString()

  // Create screen
  await db.send(new PutCommand({
    TableName: Tables.screens,
    Item: {
      pk: screenKeys.pk(auth.tenantId),
      sk: screenKeys.sk(screenId),
      gsi1pk: screenKeys.gsi1pk(auth.tenantId),
      gsi1sk: screenKeys.gsi1sk(now),
      screenId,
      tenantId: auth.tenantId,
      name: body.screenName,
      deviceType: pairing.deviceType,
      isActive: true,
      vpn: '', macAddress: '', connection: '', hostname: '',
      deviceModel: '', serial: '', memorySize: '', memoryUsage: '',
      temperature: '', orientation: 'horizontal', tvStatus: 'unknown',
      isActiveSource: false, tvMetadata: '', ansibleVersion: '',
      appVersion: '', fcmToken: '', deviceState: 'starting',
      reportedAt: null, createdAt: now, updatedAt: now,
    },
  }))

  // Create name lookup index
  await db.send(new PutCommand({
    TableName: Tables.screens,
    Item: {
      pk: `TENANT#${auth.tenantId}`,
      sk: `SCREENNAME#${body.screenName}`,
      screenId,
      tenantId: auth.tenantId,
    },
  }))

  // Create device token → screen mapping
  await db.send(new PutCommand({
    TableName: Tables.screens,
    Item: {
      pk: deviceTokenKeys.pk(token),
      sk: deviceTokenKeys.sk(),
      token,
      screenId,
      tenantId: auth.tenantId,
    },
  }))

  // Mark pairing as done
  await db.send(new UpdateCommand({
    TableName: Tables.pairing,
    Key: { pk: pairingKeys.pk(body.pin), sk: pairingKeys.sk() },
    UpdateExpression: 'SET pairedAt = :now, tenantId = :tid, screenId = :sid, screenName = :name, #token = :tok',
    ExpressionAttributeNames: { '#token': 'token' },
    ExpressionAttributeValues: {
      ':now': now, ':tid': auth.tenantId,
      ':sid': screenId, ':name': body.screenName, ':tok': token,
    },
  }))

  return ok({ status: 'paired', screenId, screenName: body.screenName, companyId: auth.tenantId })
})

/** GET /pairing/status/:pin — TV polls until paired (no auth required) */
router.get('/pairing/status/:pin', async (event) => {
  const pin = event.pathParameters?.pin ?? ''
  const res = await db.send(new GetCommand({
    TableName: Tables.pairing,
    Key: { pk: pairingKeys.pk(pin), sk: pairingKeys.sk() },
  }))

  if (!res.Item) return notFound('PIN not found.')
  const pairing = res.Item

  if (pairing.pairedAt) {
    return ok({
      paired: true,
      token: pairing.token,
      screenId: pairing.screenId,
      screenName: pairing.screenName,
      companyId: pairing.tenantId,
      apiUrl: process.env.API_BASE_URL,
    })
  }

  const expired = new Date(pairing.expiresAt as string) < new Date()
  return ok({ paired: false, expired })
})

export const handler = (event: APIGatewayProxyEventV2) => router.handle(event)
