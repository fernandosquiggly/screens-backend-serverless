// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface AuthContext {
  userId: string
  tenantId: string   // = companyId
  email: string
  role: 'admin' | 'viewer'
}

// ─── Device types ─────────────────────────────────────────────────────────────

export type DeviceType = 'raspberry_pi' | 'android_tv'
export type DeviceState = 'starting' | 'playing' | 'idle' | 'dimmed' | 'rebooting' | 'downloading' | 'unknown'
export type TvStatus = 'on' | 'standby' | 'disconnected' | 'unknown' | 'not_supported'
export type Orientation = 'horizontal' | 'vertical'
export type CommandType =
  | 'Remove file' | 'Reboot' | 'Shutdown' | 'Startup'
  | 'Set orientation' | 'Set background' | 'Create XML'
  | 'Update video' | 'Schedule power'

// ─── Screen ───────────────────────────────────────────────────────────────────

export interface Screen {
  screenId: string
  tenantId: string
  name: string
  deviceType: DeviceType
  isActive: boolean

  // Telemetry
  vpn: string
  macAddress: string
  connection: string
  hostname: string
  deviceModel: string
  serial: string
  memorySize: string
  memoryUsage: string
  temperature: string
  orientation: Orientation
  ansibleVersion: string
  appVersion: string
  fcmToken: string

  // TV state
  tvStatus: TvStatus
  isActiveSource: boolean
  tvMetadata: string
  deviceState: DeviceState
  deviceStateAt: string | null

  reportedAt: string | null
  createdAt: string
  updatedAt: string

  // Computed
  isOnline?: boolean
}

export interface ScreenCommand {
  commandId: string
  screenId: string
  tenantId: string
  type: CommandType
  payload: string
  executed: boolean
  createdAt: string
  executedAt: string | null
}

export interface ScreenMediaFile {
  screenId: string
  filename: string
  filePath: string
  type: 'video' | 'image'
  position: number
  isPlaying: boolean
  reproducible: boolean
  error: string | null
  reportedAt: string
}

// ─── Campaign ─────────────────────────────────────────────────────────────────

export interface CampaignSchedule {
  days: number[]      // 0=Sun … 6=Sat — empty means every day
  startTime: string   // "08:00" local time in timezone
  endTime: string     // "20:00"
  timezone: string    // IANA tz, e.g. "America/Argentina/Buenos_Aires"
}

export interface Campaign {
  campaignId: string
  tenantId: string
  name: string
  s3Key: string
  contentHash: string
  isActive: boolean
  screenIds: string[]
  schedule: CampaignSchedule | null
  createdAt: string
  updatedAt: string
}

export interface CampaignMedia {
  mediaId: string
  campaignId: string
  tenantId: string
  filename: string
  s3Key: string
  url?: string
  mediaType: 'image' | 'video'
  order: number
  sizeBytes: number
  durationSeconds: number   // seconds per slide for images; ignored for videos
  width?: number
  height?: number
  createdAt: string
}

// ─── Pairing ──────────────────────────────────────────────────────────────────

export interface PairingRequest {
  pin: string
  deviceType: DeviceType
  tenantId: string | null
  screenId: string | null
  screenName: string | null
  token: string | null
  expiresAt: string
  pairedAt: string | null
  createdAt: string
}

// ─── API response envelope ────────────────────────────────────────────────────

export interface ApiOk<T> { success: true; data: T }
export interface ApiError { success: false; error: string }
export type ApiResponse<T> = ApiOk<T> | ApiError

// ─── Dashboard stats ──────────────────────────────────────────────────────────

export interface DashboardStats {
  totalScreens: number
  onlineScreens: number
  offlineScreens: number
  totalCampaigns: number
  activeCampaigns: number
  deviceTypes: { raspberry_pi: number; android_tv: number }
}
