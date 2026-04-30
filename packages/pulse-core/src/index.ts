export { EventEngine } from "./EventEngine.js";
export { Watcher } from "./Watcher.js";
export { StrKey } from "@stellar/stellar-sdk";

/** The Stellar network to connect to. */
export type Network = "mainnet" | "testnet";

/** Event types for payment-related events (received, sent, or self-payment). */
export type PaymentEventType =
  | "payment.received"
  | "payment.sent"
  | "payment.self";

/** Event type for account options changes. */
export type AccountOptionsEventType = "account.options_changed";

/** Event types for trustline lifecycle events. */
export type TrustlineEventType =
  | "trustline.added"
  | "trustline.removed"
  | "trustline.updated";

/** Event type for account merges. */
export type AccountMergeEventType = "account.merged";

/** Notification types emitted by the EventEngine. */
export type WatcherNotificationType =
  | "engine.reconnecting"
  | "engine.reconnected";

/**
 * Represents a signer in Stellar account options.
 */
export type SetOptionsSigner = {
  key: string;
  weight: number;
};

/**
 * Changes to an account's options.
 */
export type AccountOptionsChanges = {
  signer_added?: SetOptionsSigner;
  signer_removed?: SetOptionsSigner;
  thresholds?: {
    low_threshold?: number;
    med_threshold?: number;
    high_threshold?: number;
    master_key_weight?: number;
  };
  home_domain?: string;
};

/**
 * Payment event.
 */
export type PaymentEvent = {
  type: PaymentEventType;
  to: string;
  from: string;
  amount: string;
  asset: string;
  timestamp: string;
  raw: unknown;
};

/**
 * Account options event.
 */
export type AccountOptionsEvent = {
  type: AccountOptionsEventType;
  source: string;
  changes: AccountOptionsChanges;
  timestamp: string;
  raw: unknown;
};

/**
 * Trustline event.
 */
export type TrustlineEvent = {
  type: TrustlineEventType;
  account: string;
  asset: string;
  limit: string;
  timestamp: string;
  raw: unknown;
};

/**
 * Account merge event.
 */
export type AccountMergeEvent = {
  type: AccountMergeEventType;
  source: string;
  destination: string;
  timestamp: string;
  raw: unknown;
};

/**
 * Union of all normalized events.
 */
export type NormalizedEvent =
  | PaymentEvent
  | AccountOptionsEvent
  | TrustlineEvent
  | AccountMergeEvent;

/**
 * Reconnection notification.
 */
export type WatcherNotification = {
  type: WatcherNotificationType;
  attempt: number;
  delayMs?: number;
  timestamp: string;
};

/**
 * Reconnection config.
 */
export type ReconnectConfig = {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
};

/**
 * Core config.
 */
export type CoreConfig = {
  network: Network;
  horizonUrl?: string;
  reconnect?: ReconnectConfig;
  logger?: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
};

/**
 * Error for invalid network.
 */
export class UnknownNetworkError extends Error {
  constructor(network: string) {
    const validNetworks = ["mainnet", "testnet"].join(", ");
    super(`Unknown network: "${network}". Valid networks: ${validNetworks}`);
    this.name = "UnknownNetworkError";
  }
}