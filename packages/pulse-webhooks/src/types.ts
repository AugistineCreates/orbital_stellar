export type WebhookConfig = {
  url: string;
  secret: string;
  retries?: number;
  deliveryTimeoutMs?: number;
};
