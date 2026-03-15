// packages/pulse-core/src/Watcher.ts
import { EventEmitter } from "events";
import type { NormalizedEvent } from "./index.js";

export class Watcher extends EventEmitter {
  readonly address: string;
  private _stopped: boolean = false;

  constructor(address: string) {
    super();
    this.address = address;
  }

  on(eventType: string, handler: (event: NormalizedEvent) => void): this {
    if (this._stopped) return this;
    return super.on(eventType, handler);
  }

  emit(eventType: string, event: NormalizedEvent): boolean {
    if (this._stopped) return false;
    return super.emit(eventType, event);
  }

  stop(): void {
    this._stopped = true;
    this.removeAllListeners();
  }
}