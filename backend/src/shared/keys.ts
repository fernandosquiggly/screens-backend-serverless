// Central key definitions — never use inline strings for DynamoDB keys

export const screenKeys = {
  pk: (tenantId: string) => `TENANT#${tenantId}`,
  sk: (screenId: string) => `SCREEN#${screenId}`,
  gsi1pk: (tenantId: string) => `SCREENS#${tenantId}`,
  gsi1sk: (reportedAt: string) => `REPORTED#${reportedAt}`,
  byName: (tenantId: string, name: string) => ({ pk: `TENANT#${tenantId}`, sk: `SCREENNAME#${name}` }),
}

export const commandKeys = {
  pk: (screenId: string) => `SCREEN#${screenId}`,
  sk: (commandId: string) => `CMD#${commandId}`,
  gsi1pk: (screenId: string) => `CMDS#${screenId}`,
}

export const campaignKeys = {
  pk: (tenantId: string) => `TENANT#${tenantId}`,
  sk: (campaignId: string) => `CAMPAIGN#${campaignId}`,
  gsi1pk: (tenantId: string) => `CAMPAIGNS#${tenantId}`,
}

export const campaignScreenKeys = {
  pk: (campaignId: string) => `CAMPAIGN#${campaignId}`,
  sk: (screenId: string) => `SCREEN#${screenId}`,
}

export const mediaKeys = {
  pk: (campaignId: string) => `CAMPAIGN#${campaignId}`,
  sk: (mediaId: string) => `MEDIA#${mediaId}`,
}

export const pairingKeys = {
  pk: (pin: string) => `PIN#${pin}`,
  sk: () => `REQUEST`,
}

export const screenMediaKeys = {
  pk: (screenId: string) => `SCREEN#${screenId}`,
  sk: () => `NOWPLAYING`,
}

export const deviceTokenKeys = {
  pk: (token: string) => `DEVICETOKEN#${token}`,
  sk: () => `TOKEN`,
}
