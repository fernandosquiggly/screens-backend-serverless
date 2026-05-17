import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  SignUpCommand,
  ConfirmSignUpCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  RespondToAuthChallengeCommand,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
  NotAuthorizedException,
  UserNotConfirmedException,
} from '@aws-sdk/client-cognito-identity-provider'
import { Router, parseBody } from '../../shared/router.js'
import { ok, badRequest, unauthorized, serverError, created } from '../../shared/response.js'
import { getAuthContext } from '../../shared/auth.js'

const cognito = new CognitoIdentityProviderClient({})
const CLIENT_ID  = process.env.COGNITO_CLIENT_ID!
const POOL_ID    = process.env.COGNITO_USER_POOL_ID!

const router = new Router()

// ── POST /auth/login ──────────────────────────────────────────────────────────

router.post('/auth/login', async (event) => {
  const body = parseBody<{ email: string; password: string }>(event)
  if (!body?.email || !body?.password) return badRequest('email and password required')

  try {
    const res = await cognito.send(new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: body.email, PASSWORD: body.password },
    }))

    if (res.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
      return ok({
        challenge: 'NEW_PASSWORD_REQUIRED',
        session: res.Session,
      })
    }

    const tokens = res.AuthenticationResult!
    return ok({
      accessToken:  tokens.AccessToken,
      idToken:      tokens.IdToken,
      refreshToken: tokens.RefreshToken,
      expiresIn:    tokens.ExpiresIn,
    })
  } catch (err: any) {
    if (err instanceof NotAuthorizedException) return unauthorized('Invalid email or password')
    if (err instanceof UserNotConfirmedException) return badRequest('Email not confirmed')
    console.error('auth/login error', err)
    return serverError()
  }
})

// ── POST /auth/refresh ────────────────────────────────────────────────────────

router.post('/auth/refresh', async (event) => {
  const body = parseBody<{ refreshToken: string }>(event)
  if (!body?.refreshToken) return badRequest('refreshToken required')

  try {
    const res = await cognito.send(new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: body.refreshToken },
    }))
    const tokens = res.AuthenticationResult!
    return ok({
      accessToken: tokens.AccessToken,
      idToken:     tokens.IdToken,
      expiresIn:   tokens.ExpiresIn,
    })
  } catch (err: any) {
    if (err instanceof NotAuthorizedException) return unauthorized('Refresh token expired')
    return serverError()
  }
})

// ── POST /auth/signup ─────────────────────────────────────────────────────────

router.post('/auth/signup', async (event) => {
  const body = parseBody<{ email: string; password: string; tenantId: string }>(event)
  if (!body?.email || !body?.password || !body?.tenantId) {
    return badRequest('email, password and tenantId required')
  }

  try {
    await cognito.send(new SignUpCommand({
      ClientId: CLIENT_ID,
      Username: body.email,
      Password: body.password,
      UserAttributes: [
        { Name: 'email',             Value: body.email },
        { Name: 'custom:tenantId',   Value: body.tenantId },
        { Name: 'custom:role',       Value: 'admin' },
      ],
    }))
    return created({ message: 'User created. Check email for confirmation code.' })
  } catch (err: any) {
    if (err.name === 'UsernameExistsException') return badRequest('Email already registered')
    if (err.name === 'InvalidPasswordException') return badRequest(err.message)
    console.error('auth/signup error', err)
    return serverError()
  }
})

// ── POST /auth/confirm ────────────────────────────────────────────────────────

router.post('/auth/confirm', async (event) => {
  const body = parseBody<{ email: string; code: string }>(event)
  if (!body?.email || !body?.code) return badRequest('email and code required')

  try {
    await cognito.send(new ConfirmSignUpCommand({
      ClientId: CLIENT_ID,
      Username: body.email,
      ConfirmationCode: body.code,
    }))
    return ok({ message: 'Email confirmed' })
  } catch (err: any) {
    if (err.name === 'CodeMismatchException') return badRequest('Invalid code')
    if (err.name === 'ExpiredCodeException')  return badRequest('Code expired')
    return serverError()
  }
})

// ── POST /auth/forgot-password ────────────────────────────────────────────────

router.post('/auth/forgot-password', async (event) => {
  const body = parseBody<{ email: string }>(event)
  if (!body?.email) return badRequest('email required')

  try {
    await cognito.send(new ForgotPasswordCommand({ ClientId: CLIENT_ID, Username: body.email }))
    return ok({ message: 'Reset code sent' })
  } catch {
    // always 200 to avoid email enumeration
    return ok({ message: 'Reset code sent' })
  }
})

// ── POST /auth/reset-password ─────────────────────────────────────────────────

router.post('/auth/reset-password', async (event) => {
  const body = parseBody<{ email: string; code: string; newPassword: string }>(event)
  if (!body?.email || !body?.code || !body?.newPassword) {
    return badRequest('email, code and newPassword required')
  }

  try {
    await cognito.send(new ConfirmForgotPasswordCommand({
      ClientId: CLIENT_ID,
      Username: body.email,
      ConfirmationCode: body.code,
      Password: body.newPassword,
    }))
    return ok({ message: 'Password reset' })
  } catch (err: any) {
    if (err.name === 'CodeMismatchException') return badRequest('Invalid code')
    if (err.name === 'ExpiredCodeException')  return badRequest('Code expired')
    return serverError()
  }
})

// ── POST /auth/new-password ───────────────────────────────────────────────────
// Responds to NEW_PASSWORD_REQUIRED challenge from first login

router.post('/auth/new-password', async (event) => {
  const body = parseBody<{ email: string; session: string; newPassword: string }>(event)
  if (!body?.email || !body?.session || !body?.newPassword) {
    return badRequest('email, session and newPassword required')
  }

  try {
    const res = await cognito.send(new RespondToAuthChallengeCommand({
      ClientId: CLIENT_ID,
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: body.session,
      ChallengeResponses: { USERNAME: body.email, NEW_PASSWORD: body.newPassword },
    }))
    const tokens = res.AuthenticationResult!
    return ok({
      accessToken:  tokens.AccessToken,
      idToken:      tokens.IdToken,
      refreshToken: tokens.RefreshToken,
      expiresIn:    tokens.ExpiresIn,
    })
  } catch (err: any) {
    if (err instanceof NotAuthorizedException) return unauthorized('Session expired')
    return serverError()
  }
})

// ── GET /auth/me ──────────────────────────────────────────────────────────────

router.get('/auth/me', async (event) => {
  const auth = await getAuthContext(event)
  if (!auth) return unauthorized()

  try {
    const user = await cognito.send(new AdminGetUserCommand({
      UserPoolId: POOL_ID,
      Username: auth.email,
    }))
    const attr = (name: string) =>
      user.UserAttributes?.find(a => a.Name === name)?.Value ?? null

    return ok({
      userId:   auth.userId,
      email:    auth.email,
      tenantId: auth.tenantId,
      role:     auth.role,
      status:   user.UserStatus,
    })
  } catch {
    return serverError()
  }
})

export const handler = async (event: APIGatewayProxyEventV2) => router.handle(event)
