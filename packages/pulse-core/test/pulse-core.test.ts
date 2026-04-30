import { Horizon } from "@stellar/stellar-sdk";
import { Watcher } from "./Watcher.js";
import type {
  AccountMergeEvent,
  AccountOptionsChanges,
  AccountOptionsEvent,
  CoreConfig,
  Network,
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
  ReturnType<Horizon.Server["operations"]>["stream"]
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
        if (!["http:", "https:"].includes(parsed.protocol)) {
          throw new Error("must be http/https");
        }
      } catch (err) {
        throw new Error(`Invalid horizonUrl: ${(err as Error).message}`);
      }
      horizonUrl = config.horizonUrl;
    } else {
      const url = HORIZON_URLS[config.network];
      if (!url) throw new UnknownNetworkError(config.network);
      horizonUrl = url;
    }

    this.server = new Horizon.Server(horizonUrl);
    this.reconnectConfig = { ...DEFAULT_RECONNECT, ...config.reconnect };
    this.log = config.logger ?? noop;
  }

  subscribe(address: string): Watcher {
    const existing = this.registry.get(address);
    if (existing) return existing;

    const watcher = new Watcher(address);
    watcher.addStopHandler(() => this.registry.delete(address));
    this.registry.set(address, watcher);
    return watcher;
  }

  unsubscribe(address: string): void {
    this.registry.get(address)?.stop();
  }

  // ✅ required by tests
  unsubscribeAll(): void {
    for (const watcher of this.registry.values()) {
      watcher.stop();
    }
  }

  start(): void {
    if (this.isRunning || this.reconnectTimer) {
      this.log.warn(
        "[pulse-core] EventEngine.start() called while the SSE stream is already active."
      );
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

          this.log.info(
            `[pulse-core] SSE reconnect succeeded on attempt ${attempt}.`
          );

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
      onerror: () => this.handleStreamError(),
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

    const attempt = ++this.reconnectAttempt;

    if (attempt > this.reconnectConfig.maxRetries) return;

    const delay = Math.min(
      this.reconnectConfig.initialDelayMs * 2 ** (attempt - 1),
      this.reconnectConfig.maxDelayMs
    );

    this.log.warn(
      `[pulse-core] SSE reconnect attempt ${attempt} scheduled in ${delay}ms.`
    );

    this.notifyWatchers("engine.reconnecting", {
      type: "engine.reconnecting",
      attempt,
      delayMs: delay,
      timestamp: new Date().toISOString(),
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openStream(true);
    }, delay);
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
  ) {
    for (const watcher of this.registry.values()) {
      watcher.emit(type, event);
    }
  }

  private normalize(record: unknown): NormalizedEventOrPending | null {
    const r = record as Record<string, any>;

    if (r.type === "payment") {
      const required = ["to", "from", "amount", "created_at"];
      for (const f of required) {
        if (!r[f]) {
          this.log.warn(
            `[pulse-core] normalize() dropping payment record: field "${f}" is missing or not a non-empty string.`
          );
          return null;
        }
      }

      return {
        type: "unknown",
        to: r.to,
        from: r.from,
        amount: r.amount,
        asset:
          r.asset_type === "native"
            ? "XLM"
            : `${r.asset_code}:${r.asset_issuer}`,
        timestamp: r.created_at,
        raw: record,
      };
    }

    if (r.type === "change_trust") {
      if (!r.source_account || !r.limit) return null;

      const limit = String(r.limit);

      return {
        type:
          limit === "0" || limit === "0.0000000"
            ? "trustline.removed"
            : limit === STELLAR_MAX_TRUSTLINE_LIMIT
            ? "trustline.added"
            : "trustline.updated",
        account: r.source_account,
        asset:
          r.asset_type === "native"
            ? "XLM"
            : `${r.asset_code}:${r.asset_issuer}`,
        limit,
        timestamp: r.created_at,
        raw: record,
      };
    }

    if (r.type === "account_merge") {
      return {
        type: "account.merged",
        source: r.account,
        destination: r.into,
        timestamp: r.created_at,
        raw: record,
      };
    }

    return null;
  }

  private route(event: NormalizedEventOrPending): void {
    if (event.type === "account.merged") {
      this.registry.get(event.source)?.emit("account.merged", event);
      this.registry.get(event.destination)?.emit("account.merged", event);
      return;
    }

    if (
      event.type === "trustline.added" ||
      event.type === "trustline.removed" ||
      event.type === "trustline.updated"
    ) {
      this.registry.get(event.account)?.emit(event.type, event);
      return;
    }

    if (event.type === "unknown") {
      if (event.from === event.to) {
        this.registry
          .get(event.to)
          ?.emit("payment.self", { ...event, type: "payment.self" });
        return;
      }

      this.registry
        .get(event.to)
        ?.emit("payment.received", { ...event, type: "payment.received" });

      this.registry
        .get(event.from)
        ?.emit("payment.sent", { ...event, type: "payment.sent" });
    }
  }
}