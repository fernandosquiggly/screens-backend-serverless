import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'

const raw = new DynamoDBClient({})
export const db = DynamoDBDocumentClient.from(raw, {
  marshallOptions: { removeUndefinedValues: true },
})

export const Tables = {
  screens:   process.env.SCREENS_TABLE!,
  campaigns: process.env.CAMPAIGNS_TABLE!,
  pairing:   process.env.PAIRING_TABLE!,
  media:     process.env.MEDIA_TABLE!,
} as const
