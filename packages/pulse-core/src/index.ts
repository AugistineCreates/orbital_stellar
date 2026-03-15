// packages/pulse-core/src/index.ts
import { Horizon } from "@stellar/stellar-sdk";
import { Watcher } from "./Watcher.js";

// --- Types ---
export type Network = "mainnet" | "testnet";

export type NormalizedEvent = {
  type: "payment.received" | "payment.sent";
  to: string;
  from: string;
  amount: string;
  asset: string;
  timestamp: string;
  raw: unknown;
};

export type CoreConfig = {
  network: Network;
};

const HORIZON_URLS: Record<Network, string> = {
  mainnet: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
};

// --- EventEngine class ---
export class EventEngine {
  private server: Horizon.Server;
  private registry: Map<string, Watcher> = new Map();
  private stopStream: (() => void) | null = null;

  constructor(config: CoreConfig) {
    this.server = new Horizon.Server(HORIZON_URLS[config.network]);
  }

  // Subscribe — one watcher per address
  subscribe(address: string): Watcher {
    if (this.registry.has(address)) {
      return this.registry.get(address)!;
    }
    const watcher = new Watcher(address);
    this.registry.set(address, watcher);
    return watcher;
  }

  // Unsubscribe — stop and remove watcher
  unsubscribe(address: string): void {
    const watcher = this.registry.get(address);
    if (watcher) {
      watcher.stop();
      this.registry.delete(address);
    }
  }

  // Start listening to Horizon SSE
  start(): void {
    this.stopStream = this.server
      .payments()
      .cursor("now")
      .stream({
        onmessage: (record) => {
          const event = this.normalize(record);
          if (!event) return;
          this.route(event);
        },
        onerror: (error) => {
          console.error("[pulse-core] SSE error:", error);
        },
      });
  }

  // Stop the SSE stream and clear registry
  stop(): void {
    if (this.stopStream) {
      this.stopStream();
      this.stopStream = null;
    }
    this.registry.forEach((watcher) => watcher.stop());
    this.registry.clear();
  }

  // Normalize raw Horizon record into clean event
  private normalize(record: unknown): NormalizedEvent | null {
    const r = record as Record<string, unknown>;
    if (r.type !== "payment") return null;

    const asset =
      r.asset_type === "native"
        ? "XLM"
        : `${r.asset_code}:${r.asset_issuer}`;

    return {
      type: "payment.received", // resolved during routing
      to: r.to as string,
      from: r.from as string,
      amount: r.amount as string,
      asset,
      timestamp: r.created_at as string,
      raw: record,
    };
  }

  // Route event to matching watchers
  private route(event: NormalizedEvent): void {
    // Check if recipient is being watched
    const toWatcher = this.registry.get(event.to);
    if (toWatcher) {
      toWatcher.emit("payment.received", {
        ...event,
        type: "payment.received",
      });
      toWatcher.emit("*", { ...event, type: "payment.received" });
    }

    // Check if sender is being watched
    const fromWatcher = this.registry.get(event.from);
    if (fromWatcher) {
      fromWatcher.emit("payment.sent", {
        ...event,
        type: "payment.sent",
      });
      fromWatcher.emit("*", { ...event, type: "payment.sent" });
    }
  }
}