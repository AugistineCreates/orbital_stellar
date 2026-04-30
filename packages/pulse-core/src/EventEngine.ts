import { Horizon } from "@stellar/stellar-sdk";
import { Watcher } from "./Watcher.js";
import type {
  AccountMergeEvent,
  AccountOptionsChanges,
  AccountOptionsEvent,
  CoreConfig,
  Network,
  NormalizedEvent,
  PaymentEvent,
  PaymentEventType,
  ReconnectConfig,
  TrustlineEvent,
  TrustlineEventType,
  WatcherNotification,
  WatcherNotificationType,
} from "./index.js";
import { UnknownNetworkError } from "./index.js";

type PendingPaymentEvent = Omit<PaymentEvent, "type"> & { type: "unknown" };

type NormalizedEventOrPending =
  | PendingPaymentEvent
  | AccountOptionsEvent
  | TrustlineEvent
  | AccountMergeEvent;

type StreamCallbacks = {
  onmessage: (record: unknown) => void;
  onerror: (error: unknown) => void;
};

type HorizonStreamStopper = ReturnType<
  ReturnType<Horizon.Server["payments"]>["stream"]
>;

const HORIZON_URLS: Record<Network, string> = {
  mainnet: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
};

const DEFAULT_RECONNECT: Required<ReconnectConfig> = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  maxRetries: Number.POSITIVE_INFINITY,
};

const STELLAR_MAX_TRUSTLINE_LIMIT = "922337203685.4775807";

const noop = { info: () => {}, warn: () => {}, error: () => {} };

export class EventEngine {
  private server: Horizon.Server;
  private registry: Map<string, Watcher> = new Map();
  private stopStream: HorizonStreamStopper | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private pendingReconnectSuccessAttempt: number | null = null;
  private readonly reconnectConfig: Required<ReconnectConfig>;
  private isRunning = false;
  private log: Required<NonNullable<CoreConfig["logger"]>>;

  constructor(config: CoreConfig) {
    let horizonUrl: string;

    if (config.horizonUrl !== undefined) {
      try {
        const parsed = new URL(config.horizonUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("must be an http or https URL");
        }
      } catch (err) {
        throw new Error(`Invalid horizonUrl: ${(err as Error).message}`);
      }
      horizonUrl = config.horizonUrl;
    } else {
      const fromNetwork = HORIZON_URLS[config.network];
      if (!fromNetwork) {
        throw new UnknownNetworkError(config.network);
      }
      horizonUrl = fromNetwork;
    }

    this.server = new Horizon.Server(horizonUrl);
    this.reconnectConfig = {
      ...DEFAULT_RECONNECT,
      ...config.reconnect,
    };
    this.log = config.logger ?? noop;
  }

  subscribe(address: string): Watcher {
    const existing = this.registry.get(address);
    if (existing) return existing;

    const watcher = new Watcher(address);
    watcher.addStopHandler(() => {
      this.registry.delete(address);
    });

    this.registry.set(address, watcher);
    return watcher;
  }

  unsubscribe(address: string): void {
    this.registry.get(address)?.stop();
  }

  unsubscribeAll(): void {
    for (const watcher of this.registry.values()) {
      watcher.stop();
    }
  }

  start(): void {
    if (this.isRunning || this.reconnectTimer) {
      this.log.warn("[pulse-core] EventEngine already running.");
      return;
    }
    this.openStream(false);
  }

  stop(): void {
    this.clearReconnectTimer();
    this.pendingReconnectSuccessAttempt = null;
    this.reconnectAttempt = 0;
    this.closeStream();
    this.isRunning = false;

    for (const watcher of this.registry.values()) {
      watcher.stop();
    }
  }

  private openStream(isReconnect: boolean): void {
    this.closeStream();
    this.clearReconnectTimer();
    this.isRunning = true;

    this.pendingReconnectSuccessAttempt = isReconnect
      ? this.reconnectAttempt
      : null;

    const callbacks: StreamCallbacks = {
      onmessage: (record) => {
        if (this.pendingReconnectSuccessAttempt !== null) {
          const attempt = this.pendingReconnectSuccessAttempt;
          this.pendingReconnectSuccessAttempt = null;
          this.reconnectAttempt = 0;

          this.notifyWatchers("engine.reconnected", {
            type: "engine.reconnected",
            attempt,
            timestamp: new Date().toISOString(),
          });
        }

        const event = this.normalize(record);
        if (!event) return;

        this.route(event);
      },
      onerror: () => {
        this.handleStreamError();
      },
    };

    this.stopStream = this.server
      .operations()
      .cursor("now")
      .stream(callbacks);
  }

  private handleStreamError(): void {
    if (this.reconnectTimer) return;

    this.closeStream();
    this.isRunning = false;

    const nextAttempt = this.reconnectAttempt + 1;
    if (nextAttempt > this.reconnectConfig.maxRetries) return;

    this.reconnectAttempt = nextAttempt;

    const delayMs = Math.min(
      this.reconnectConfig.initialDelayMs * 2 ** (nextAttempt - 1),
      this.reconnectConfig.maxDelayMs
    );

    this.notifyWatchers("engine.reconnecting", {
      type: "engine.reconnecting",
      attempt: nextAttempt,
      delayMs,
      timestamp: new Date().toISOString(),
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openStream(true);
    }, delayMs);
  }

  private closeStream(): void {
    if (!this.stopStream) return;
    this.stopStream();
    this.stopStream = null;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private notifyWatchers(
    type: WatcherNotificationType,
    event: WatcherNotification
  ): void {
    for (const watcher of this.registry.values()) {
      watcher.emit(type, event);
    }
  }

  private normalize(record: unknown): NormalizedEventOrPending | null {
    const r = record as Record<string, unknown>;

    if (r.type === "payment") {
      if (
        typeof r.to !== "string" ||
        typeof r.from !== "string" ||
        typeof r.amount !== "string"
      ) {
        return null;
      }

      const asset =
        r.asset_type === "native"
          ? "XLM"
          : `${r.asset_code}:${r.asset_issuer}`;

      return {
        type: "unknown",
        to: r.to,
        from: r.from,
        amount: r.amount,
        asset,
        timestamp: r.created_at as string,
        raw: record,
      };
    }

    if (r.type === "change_trust") {
      return this.normalizeChangeTrust(r, record);
    }

    if (r.type === "account_merge") {
      return {
        type: "account.merged",
        source: r.account as string,
        destination: r.into as string,
        timestamp: r.created_at as string,
        raw: record,
      };
    }

    return null;
  }

  private normalizeChangeTrust(
    r: Record<string, unknown>,
    raw: unknown
  ): TrustlineEvent | null {
    if (typeof r.source_account !== "string") return null;
    if (typeof r.limit !== "string" && typeof r.limit !== "number") return null;

    const asset =
      r.asset_type === "native"
        ? "XLM"
        : `${r.asset_code}:${r.asset_issuer}`;

    const limit = String(r.limit);

    return {
      type: limit === "0" ? "trustline.removed" : "trustline.updated",
      account: r.source_account,
      asset,
      limit,
      timestamp: r.created_at as string,
      raw,
    };
  }

  private route(event: NormalizedEventOrPending): void {
    if ("account" in event) {
      const watcher = this.registry.get(event.account);
      if (watcher) {
        watcher.emit(event.type as any, event);
        watcher.emit("*", event);
      }
      return;
    }

    if (event.type === "account.merged") {
      this.registry.get(event.source)?.emit("account.merged", event);
      this.registry.get(event.destination)?.emit("account.merged", event);
      return;
    }

    if (event.type !== "unknown") return;

    if (event.from === event.to) {
      const watcher = this.registry.get(event.to);
      if (watcher) {
        const self = this.withResolvedType(event, "payment.self");
        watcher.emit("payment.self", self);
        watcher.emit("*", self);
      }
      return;
    }

    this.registry
      .get(event.to)
      ?.emit("payment.received", this.withResolvedType(event, "payment.received"));

    this.registry
      .get(event.from)
      ?.emit("payment.sent", this.withResolvedType(event, "payment.sent"));
  }

  private withResolvedType(
    event: PendingPaymentEvent,
    type: PaymentEventType
  ): PaymentEvent {
    return { ...event, type };
  }
}