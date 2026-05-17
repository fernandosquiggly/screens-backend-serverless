import type { APIGatewayProxyResultV2 } from 'aws-lambda'

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  },
  body: JSON.stringify(body),
})

export const ok       = <T>(data: T)        => json(200, { success: true, data })
export const created  = <T>(data: T)        => json(201, { success: true, data })
export const noContent= ()                  => json(204, null)
export const badRequest = (error: string)   => json(400, { success: false, error })
export const unauthorized = (error = 'Unauthorized') => json(401, { success: false, error })
export const forbidden = ()                 => json(403, { success: false, error: 'Forbidden' })
export const notFound = (error = 'Not found') => json(404, { success: false, error })
export const conflict = (error: string)     => json(409, { success: false, error })
export const gone = (error: string)         => json(410, { success: false, error })
export const serverError = (error = 'Internal server error') => json(500, { success: false, error })
