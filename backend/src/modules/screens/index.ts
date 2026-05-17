import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { Router, parseBody } from '../../shared/router.js'
import { db, Tables } from '../../shared/db.js'
import { getAuthContext, getDeviceContext } from '../../shared/auth.js'
import { ok, created, badRequest, notFound, unauthorized, noContent } from '../../shared/response.js'
import { screenKeys, commandKeys, screenMediaKeys, deviceTokenKeys } from '../../shared/keys.js'
import type { Screen, ScreenCommand, DeviceType } from '@screens/types'

const router = new Router()
const ONLINE_CUTOFF_MS = 10 * 60 * 1000  // 10 minutes

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toScreen(item: Record<string, unknown>): Screen {
  const reportedAt = item.reportedAt as string | null
  return {
    ...item as unknown as Screen,
    isOnline: reportedAt != null && Date.now() - new Date(reportedAt).getTime() < ONLINE_CUTOFF_MS,
  }
}

const RPi_ONLY_COMMANDS = new Set(['Create XML', 'Update video', 'Set background'])

// ─── Device endpoints (used by RPi + Android TV, Token auth) ─────────────────

/** GET /device/screens/get/:name — resolve screenId from name */
router.get('/device/screens/get/:name', async (event) => {
  const ctx = await getDeviceContext(event)
  if (!ctx) return unauthorized()

  const name = event.pathParameters?.name ?? ''
  const res = await db.send(new GetCommand({
    TableName: Tables.screens,
    Key: { pk: `TENANT#${ctx.tenantId}`, sk: `SCREENNAME#${name}` },
  }))
  if (!res.Item) return notFound('Screen not found')
  return ok({ id: res.Item.screenId, name: res.Item.name, deviceType: res.Item.deviceType })
})

/** POST /device/screens/set — device reports telemetry */
router.post('/device/screens/set', async (event) => {
  const ctx = await getDeviceContext(event)
  if (!ctx) return unauthorized()

  const body = parseBody<Record<string, unknown>>(event)
  const name = body.name as string
  const now = new Date().toISOString()

  await db.send(new PutCommand({
    TableName: Tables.screens,
    Item: {
      pk: screenKeys.pk(ctx.tenantId),
      sk: screenKeys.sk(ctx.screenId),
      gsi1pk: screenKeys.gsi1pk(ctx.tenantId),
      gsi1sk: screenKeys.gsi1sk(now),
      screenId: ctx.screenId,
      tenantId: ctx.tenantId,
      name,
      deviceType: body.device_type ?? 'raspberry_pi',
      vpn: body.vpn ?? '',
      macAddress: body.mac_address ?? '',
      connection: body.connection ?? '',
      hostname: body.hostname ?? '',
      deviceModel: body.rpi_model ?? body.device_model ?? '',
      serial: body.serial ?? '',
      memorySize: body.memory_size ?? '',
      memoryUsage: body.memory_usage ?? '',
      temperature: body.temperature ?? '',
      orientation: body.orientation ?? 'horizontal',
      tvStatus: body.tv_status ?? 'unknown',
      isActiveSource: body.is_active_source ?? false,
      tvMetadata: body.tv_metadata ?? '',
      ansibleVersion: body.ansible_version ?? '',
      appVersion: body.app_version ?? '',
      reportedAt: now,
      updatedAt: now,
      isActive: true,
    },
  }))

  return ok({ id: ctx.screenId, status: 'updated' })
})

/** GET /device/screens/command/get/:screenId — device polls commands */
router.get('/device/screens/command/get/:screenId', async (event) => {
  const ctx = await getDeviceContext(event)
  if (!ctx) return unauthorized()

  const screenId = event.pathParameters?.screenId ?? ctx.screenId

  // Get screen to check device type for filtering
  const screenRes = await db.send(new GetCommand({
    TableName: Tables.screens,
    Key: { pk: screenKeys.pk(ctx.tenantId), sk: screenKeys.sk(screenId) },
  }))
  const deviceType = (screenRes.Item?.deviceType ?? 'raspberry_pi') as DeviceType

  const res = await db.send(new QueryCommand({
    TableName: Tables.screens,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    FilterExpression: 'executed = :f',
    ExpressionAttributeValues: {
      ':pk': commandKeys.pk(screenId),
      ':prefix': 'CMD#',
      ':f': false,
    },
  }))

  let commands = res.Items ?? []

  // Filter RPi-only commands for Android TV
  if (deviceType === 'android_tv') {
    commands = commands.filter(c => !RPi_ONLY_COMMANDS.has(c.type))
  }

  // Mark as executed
  const now = new Date().toISOString()
  await Promise.all(commands.map(cmd =>
    db.send(new UpdateCommand({
      TableName: Tables.screens,
      Key: { pk: commandKeys.pk(screenId), sk: commandKeys.sk(cmd.commandId) },
      UpdateExpression: 'SET executed = :t, executedAt = :now',
      ExpressionAttributeValues: { ':t': true, ':now': now },
    }))
  ))

  return ok({ results: commands.map(c => ({ id: c.commandId, type: c.type, payload: c.payload })) })
})

/** POST /device/screens/content/post/:name — device reports playing media */
router.post('/device/screens/content/post/:name', async (event) => {
  const ctx = await getDeviceContext(event)
  if (!ctx) return unauthorized()

  const files = parseBody<unknown[]>(event)
  const now = new Date().toISOString()

  await db.send(new PutCommand({
    TableName: Tables.screens,
    Item: {
      pk: screenMediaKeys.pk(ctx.screenId),
      sk: screenMediaKeys.sk(),
      screenId: ctx.screenId,
      tenantId: ctx.tenantId,
      files,
      reportedAt: now,
    },
  }))

  return ok({ status: 'received', count: Array.isArray(files) ? files.length : 0 })
})

/** POST /device/screens/state/:name — device reports current state */
router.post('/device/screens/state/:name', async (event) => {
  const ctx = await getDeviceContext(event)
  if (!ctx) return unauthorized()

  const body = parseBody<{ state: string }>(event)
  if (!body.state) return badRequest('state required')

  const now = new Date().toISOString()
  await db.send(new UpdateCommand({
    TableName: Tables.screens,
    Key: { pk: screenKeys.pk(ctx.tenantId), sk: screenKeys.sk(ctx.screenId) },
    UpdateExpression: 'SET deviceState = :s, deviceStateAt = :now, reportedAt = :now',
    ExpressionAttributeValues: { ':s': body.state, ':now': now },
  }))

  return ok({ status: 'ok', state: body.state })
})

// ─── Dashboard endpoints (Cognito JWT auth) ────────────────────────────────

/** GET /screens — list all screens for tenant */
router.get('/screens', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const res = await db.send(new QueryCommand({
    TableName: Tables.screens,
    IndexName: 'GSI1',
    KeyConditionExpression: 'gsi1pk = :pk',
    FilterExpression: 'isActive = :a AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': screenKeys.gsi1pk(auth.tenantId),
      ':a': true,
      ':prefix': 'SCREEN#',
    },
  }))

  return ok((res.Items ?? []).map(toScreen))
})

/** GET /screens/:screenId — screen detail */
router.get('/screens/:screenId', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const screenId = event.pathParameters?.screenId ?? ''
  const res = await db.send(new GetCommand({
    TableName: Tables.screens,
    Key: { pk: screenKeys.pk(auth.tenantId), sk: screenKeys.sk(screenId) },
  }))
  if (!res.Item) return notFound()
  return ok(toScreen(res.Item))
})

/** PATCH /screens/:screenId — update screen */
router.patch('/screens/:screenId', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const screenId = event.pathParameters?.screenId ?? ''
  const body = parseBody<{ name?: string; orientation?: string; isActive?: boolean }>(event)

  const expressions: string[] = []
  const vals: Record<string, unknown> = { ':now': new Date().toISOString() }

  if (body.name !== undefined)        { expressions.push('name = :n');        vals[':n'] = body.name }
  if (body.orientation !== undefined) { expressions.push('orientation = :o'); vals[':o'] = body.orientation }
  if (body.isActive !== undefined)    { expressions.push('isActive = :a');    vals[':a'] = body.isActive }
  expressions.push('updatedAt = :now')

  const res = await db.send(new UpdateCommand({
    TableName: Tables.screens,
    Key: { pk: screenKeys.pk(auth.tenantId), sk: screenKeys.sk(screenId) },
    UpdateExpression: `SET ${expressions.join(', ')}`,
    ExpressionAttributeValues: vals,
    ReturnValues: 'ALL_NEW',
  }))

  return ok(toScreen(res.Attributes as Record<string, unknown>))
})

/** DELETE /screens/:screenId — deactivate screen */
router.delete('/screens/:screenId', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const screenId = event.pathParameters?.screenId ?? ''
  await db.send(new UpdateCommand({
    TableName: Tables.screens,
    Key: { pk: screenKeys.pk(auth.tenantId), sk: screenKeys.sk(screenId) },
    UpdateExpression: 'SET isActive = :f',
    ExpressionAttributeValues: { ':f': false },
  }))

  return noContent()
})

/** POST /screens/:screenId/command — send a command */
router.post('/screens/:screenId/command', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const screenId = event.pathParameters?.screenId ?? ''
  const body = parseBody<{ type: string; payload?: string }>(event)
  if (!body.type) return badRequest('type is required')

  const commandId = randomUUID()
  const now = new Date().toISOString()

  const cmd: ScreenCommand = {
    commandId,
    screenId,
    tenantId: auth.tenantId,
    type: body.type as ScreenCommand['type'],
    payload: body.payload ?? '',
    executed: false,
    createdAt: now,
    executedAt: null,
  }

  await db.send(new PutCommand({
    TableName: Tables.screens,
    Item: {
      pk: commandKeys.pk(screenId),
      sk: commandKeys.sk(commandId),
      gsi1pk: commandKeys.gsi1pk(screenId),
      gsi1sk: now,
      ...cmd,
    },
  }))

  return created({ ...cmd, pushSent: false })
})

/** GET /screens/:screenId/commands — command history */
router.get('/screens/:screenId/commands', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const screenId = event.pathParameters?.screenId ?? ''
  const res = await db.send(new QueryCommand({
    TableName: Tables.screens,
    IndexName: 'GSI1',
    KeyConditionExpression: 'gsi1pk = :pk',
    ExpressionAttributeValues: { ':pk': commandKeys.gsi1pk(screenId) },
    ScanIndexForward: false,
    Limit: 20,
  }))

  return ok(res.Items ?? [])
})

/** GET /screens/:screenId/content — currently playing media */
router.get('/screens/:screenId/content', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const screenId = event.pathParameters?.screenId ?? ''
  const res = await db.send(new GetCommand({
    TableName: Tables.screens,
    Key: { pk: screenMediaKeys.pk(screenId), sk: screenMediaKeys.sk() },
  }))

  const files = (res.Item?.files as unknown[]) ?? []
  return ok(files)
})

/** GET /screens/stats — dashboard stats */
router.get('/screens/stats', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  const res = await db.send(new QueryCommand({
    TableName: Tables.screens,
    IndexName: 'GSI1',
    KeyConditionExpression: 'gsi1pk = :pk',
    FilterExpression: 'isActive = :a AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': screenKeys.gsi1pk(auth.tenantId),
      ':a': true,
      ':prefix': 'SCREEN#',
    },
  }))

  const screens = res.Items ?? []
  const cutoff = new Date(Date.now() - ONLINE_CUTOFF_MS).toISOString()
  const online = screens.filter(s => s.reportedAt && s.reportedAt >= cutoff).length

  return ok({
    totalScreens: screens.length,
    onlineScreens: online,
    offlineScreens: screens.length - online,
    deviceTypes: {
      raspberry_pi: screens.filter(s => s.deviceType === 'raspberry_pi').length,
      android_tv: screens.filter(s => s.deviceType === 'android_tv').length,
    },
  })
})

export const handler = (event: APIGatewayProxyEventV2) => router.handle(event)
