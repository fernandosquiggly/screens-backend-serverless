import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { CognitoJwtVerifier } from 'aws-jwt-verify'
import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { db, Tables } from './db.js'
import { deviceTokenKeys } from './keys.js'
import type { AuthContext } from '@screens/types'

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null

function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID!,
      clientId: process.env.COGNITO_CLIENT_ID!,
      tokenUse: 'access',
    })
  }
  return verifier
}

/** Verify a Cognito JWT and return the auth context. */
export async function getAuthContext(event: APIGatewayProxyEventV2): Promise<AuthContext | null> {
  const header = event.headers?.authorization ?? event.headers?.Authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return null

  try {
    const payload = await getVerifier().verify(token)
    return {
      userId: payload.sub,
      tenantId: (payload['custom:tenantId'] as string) ?? payload.sub,
      email: payload.email as string ?? '',
      role: (payload['custom:role'] as 'admin' | 'viewer') ?? 'viewer',
    }
  } catch {
    return null
  }
}

/** Authenticate a device using a plain API token stored in DynamoDB. */
export async function getDeviceContext(event: APIGatewayProxyEventV2): Promise<{ tenantId: string; screenId: string } | null> {
  const header = event.headers?.authorization ?? event.headers?.Authorization ?? ''
  const token = header.startsWith('Token ') ? header.slice(6).trim() : null
  if (!token) return null

  const res = await db.send(new GetCommand({
    TableName: Tables.screens,
    Key: { pk: deviceTokenKeys.pk(token), sk: deviceTokenKeys.sk() },
  }))
  if (!res.Item) return null

  return { tenantId: res.Item.tenantId, screenId: res.Item.screenId }
}
