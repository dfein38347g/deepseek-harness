/** Host HTTP bridge for browser-client RPC. */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
// Activates the webServer Context merge used below.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority } from './api-request-trust.ts'
import { BrowserAuth, type BasicAuthCredential } from './browser-auth.ts'
import { HostConnectionService } from './rpc-host.ts'
import { ConnectionRecoveryConfigSchema, resolveConnectionConfig, type ConnectionRecoveryConfig } from './recovery-config.ts'

export type {
  ConnectionFetchMethod,
  ConnectionFetchHandler,
  ConnectionFetchRoute,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRequestRejection,
  ConnectionRpcResult,
  ConnectionRequestBodyMode,
  ConnectionTrustRequest,
  ClientRequest,
  HostConnectionHandle,
  HostConnectionFetch,
  HostConnectionRpc,
  RpcMessage,
  ServerResponse,
} from './rpc.ts'
export { RpcId, transportError } from './rpc.ts'
export {
  clientRequestSchema,
  rpcErrorSchema,
  rpcIdSchema,
  rpcMessageSchema,
  rpcResultSchema,
  serverResponseSchema,
} from './rpc-schema.ts'
export { HostConnectionService } from './rpc-host.ts'

export { API_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection. */
export const inject = ['credentials']

/** Browser authentication, request limits, and connection recovery configuration. */
export interface ConnectionConfig {
  /** Browser recovery timing, injected into each served page. */
  recovery?: ConnectionRecoveryConfig
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by; the Web runtime derives LAN IP literals from an active all-interface
   * bind. An entry that is not a bare, canonical authority fails plugin load.
   * The same list is injected into every served page as the
   * `__DSH_TRUSTED_HOSTS__` global, so the browser's own page classification
   * (the `connection` handle's privileged-surface flag) mirrors this fence
   * instead of testing loopback hostnames only.
   */
  trustedHosts?: string[]
  /**
   * Path of a mode-600 file holding one `user:password` line. When set, the
   * browser surface additionally accepts that HTTP Basic credential on every
   * request (index, `/api`, WebSocket handshakes), and the first successful
   * index exchange mints the ordinary signed session cookie; a 401 then
   * carries `WWW-Authenticate: Basic` so any browser can prompt for it.
   * The one-time launch-token URL stays available as a local recovery path.
   * Unset (the default) keeps the token-and-cookie-only flow. A missing or
   * malformed file fails plugin load.
   */
  basicAuthFile?: string
  /** Absolute browser-session lifetime in days. Default: 30. */
  cookieMaxAgeDays?: number
  /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
}

export const Config: z<ConnectionConfig> = z.object({
  recovery: ConnectionRecoveryConfigSchema.default({}),
  trustedHosts: z.array(String).default([]),
  basicAuthFile: z.string().min(1).default(''),
  cookieMaxAgeDays: z.natural().min(1).default(30),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

/**
 * Read the single-line `user:password` file a deployment binds to the browser
 * surface.
 * @param filePath - absolute, `~`-relative, or bare path to a mode-600 file.
 * @returns the parsed credential; an empty line is a configuration error.
 */
export function loadBasicAuthFile(filePath: string): BasicAuthCredential {
  const path = filePath.startsWith('~/') ? homedir() + filePath.slice(1) : filePath
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(
      `client-connection: cannot read basic-auth file ${path}: ${String(error instanceof Error ? error.message : error)}`,
    )
  }
  if (text.endsWith('\n')) text = text.slice(0, -1)
  if (text.endsWith('\r')) text = text.slice(0, -1)
  if (text.includes('\n') || text.includes('\r')) {
    throw new Error(`client-connection: basic-auth file ${path} must hold exactly one line`)
  }
  const line = text.trim()
  const at = line.indexOf(':')
  if (at <= 0) throw new Error(`client-connection: basic-auth file ${path} must hold "user:password"`)
  const user = line.slice(0, at).trim()
  const password = line.slice(at + 1).trim()
  if (user === '' || password === '') {
    throw new Error(`client-connection: basic-auth file ${path} must hold "user:password" with non-empty fields`)
  }
  return { user, password }
}

/**
 * Provides carrier-neutral RPC and Fetch registries. When `webServer` is
 * present, the plugin also mounts the `/api` browser transport with Host/Origin
 * checks and persistent browser authentication.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config?: ConnectionConfig): Promise<void> {
  const recovery = resolveConnectionConfig(config?.recovery)
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const cookieMaxAgeDays = config?.cookieMaxAgeDays ?? 30
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  // Config boundary: a missing or malformed credential file fails the load
  // loudly here rather than silently leaving the surface on the token flow.
  const basicAuth = config?.basicAuthFile !== undefined && config.basicAuthFile !== ''
    ? loadBasicAuthFile(config.basicAuthFile)
    : undefined
  const connection = new HostConnectionService(
    ctx,
    trustedHosts,
    await BrowserAuth.create(ctx.root, ctx.credentials, cookieMaxAgeDays, basicAuth),
  )
  ctx.inject(['webServer'], (webCtx) => {
    assertImageBodyCapacity(webCtx, maxRequestBodyBytes)
    webCtx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: recovery })
      // The page-side mirror of this fence's Host decision: a served page
      // names its own authority in `location`, and the client classifies it
      // against the very list the fence applies to that page's requests.
      table.push({ kind: 'global', name: '__DSH_TRUSTED_HOSTS__', value: trustedHosts })
    })
    const fetchHandler = connection.createSharedFetchHandler(API_PATH)
    const route: WebRoute = {
      kind: 'prefix',
      path: API_PATH,
      handler: async (req, res) => {
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await bridge(req, res, fetchHandler, maxRequestBodyBytes)
      },
    }
    webCtx.effect(() => webCtx.webServer.register(route), 'client-connection: /api route')
  })
  ctx.inject(['attachments'], (attachmentCtx) => {
    assertImageBodyCapacity(attachmentCtx, maxRequestBodyBytes)
  })
}
