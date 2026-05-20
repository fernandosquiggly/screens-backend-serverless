import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'

type Handler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>

interface Route { method: string; pattern: RegExp; paramNames: string[]; handler: Handler }

export class Router {
  private routes: Route[] = []

  private add(method: string, path: string, handler: Handler) {
    const paramNames: string[] = []
    const pattern = new RegExp(
      '^' + path.replace(/:([^/]+)/g, (_, name) => { paramNames.push(name); return '([^/]+)' }) + '$'
    )
    this.routes.push({ method, pattern, paramNames, handler })
  }

  get   (path: string, h: Handler) { this.add('GET',    path, h) }
  post  (path: string, h: Handler) { this.add('POST',   path, h) }
  put   (path: string, h: Handler) { this.add('PUT',    path, h) }
  patch (path: string, h: Handler) { this.add('PATCH',  path, h) }
  delete(path: string, h: Handler) { this.add('DELETE', path, h) }

  async handle(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const CORS = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    }

    const method = event.requestContext.http.method
    const path = event.rawPath

    // Handle preflight
    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' }, body: '' }
    }

    for (const route of this.routes) {
      if (route.method !== method) continue
      const match = path.match(route.pattern)
      if (!match) continue

      const pathParameters: Record<string, string> = {}
      route.paramNames.forEach((name, i) => { pathParameters[name] = decodeURIComponent(match[i + 1]) })
      event.pathParameters = { ...event.pathParameters, ...pathParameters }

      try {
        return await route.handler(event)
      } catch (err) {
        console.error(`[router] unhandled error in ${method} ${path}:`, err)
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ success: false, error: 'Internal server error' }) }
      }
    }

    return { statusCode: 404, headers: CORS, body: JSON.stringify({ success: false, error: 'Route not found' }) }
  }
}

export const parseBody = <T>(event: APIGatewayProxyEventV2): T => {
  try { return JSON.parse(event.body ?? '{}') as T } catch { return {} as T }
}
