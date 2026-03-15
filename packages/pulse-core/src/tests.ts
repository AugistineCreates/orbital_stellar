import { EventEngine } from "./index.js";

const engine = new EventEngine({ network: "testnet" });

// Subscribe to two addresses
const watcher1 = engine.subscribe("GABC...1234");
const watcher2 = engine.subscribe("GXYZ...5678");

// Make sure same address returns same watcher
const watcher1Again = engine.subscribe("GABC...1234");
console.log("Same watcher returned:", watcher1 === watcher1Again); // should be true

// Test event listeners
watcher1.on("payment.received", (event) => {
    console.log("watcher1 received payment:", event.amount, event.asset);
});

watcher1.on("*", (event) => {
    console.log("watcher1 wildcard fired:", event.type);
});

// Manually trigger a fake event to test routing
// @ts-ignore — accessing private method for testing only
engine["route"]({
    type: "payment.received",
    to: "GABC...1234",
    from: "GXYZ...5678",
    amount: "100",
    asset: "USDC",
    timestamp: new Date().toISOString(),
    raw: {},
});

// Test stop
watcher1.stop();
console.log("After stop — this should NOT fire:");
// @ts-ignore
engine["route"]({
    type: "payment.received",
    to: "GABC...1234",
    from: "GXYZ...5678",
    amount: "50",
    asset: "XLM",
    timestamp: new Date().toISOString(),
    raw: {},
});

console.log("Test complete");