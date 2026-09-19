import { describe, expect, it } from "vitest";
import { renderSubscription, validateNodeConfig } from "../src/worker/protocols";
import type { NodeRow, Protocol } from "../src/worker/types";

const credential = { uuid: "7cb3a132-f2d7-4dad-a3b2-d95b45f5f50a", secret: "test-secret" };
const configs: Record<Protocol, Record<string, unknown>> = {
  shadowsocks: { server: "ss.example.com", port: 443, method: "aes-256-gcm" },
  vmess: { server: "vm.example.com", port: 443, tls: true, sni: "vm.example.com", transport: "ws", path: "/ws" },
  vless: { server: "vl.example.com", port: 443, tls: true, sni: "vl.example.com", transport: "tcp" },
  trojan: { server: "tr.example.com", port: 443, sni: "tr.example.com", transport: "tcp" },
  hysteria2: { server: "hy.example.com", port: 443, sni: "hy.example.com", upMbps: 100, downMbps: 200 },
  tuic: { server: "tu.example.com", port: 443, sni: "tu.example.com", congestionControl: "bbr", udpRelayMode: "native" },
};

function nodes(): NodeRow[] {
  return (Object.keys(configs) as Protocol[]).map((protocol, index) => ({
    id: `node_${index}`, owner_admin_id: "admin", name: `Test ${protocol}`, protocol, status: "approved",
    config_json: JSON.stringify(validateNodeConfig(protocol, configs[protocol])), token_hash: "hash", last_seen_at: null,
    online_count: 0, agent_version: null, created_at: 1, updated_at: 1,
  }));
}

describe("protocol validation and rendering", () => {
  it("rejects invalid ports and methods", () => {
    expect(() => validateNodeConfig("vless", { server: "x", port: 70000 })).toThrow();
    expect(() => validateNodeConfig("shadowsocks", { server: "x", port: 443, method: "rc4" })).toThrow();
  });

  it("renders all six protocols for Clash Meta and sing-box", () => {
    const clash = renderSubscription("clash", nodes(), credential);
    const singbox = renderSubscription("singbox", nodes(), credential);
    expect(clash.body).toContain("hysteria2");
    expect(clash.body).toContain("tuic");
    expect(clash.body).toContain("proxy-groups:");
    expect(clash.body).toContain("GEOIP,CN,DIRECT");
    const singboxConfig = JSON.parse(singbox.body);
    expect(singboxConfig.outbounds.filter((outbound: { server?: string }) => outbound.server)).toHaveLength(6);
    expect(singboxConfig.route.final).toBe("Proxy");
    expect(singboxConfig.route.rule_set).toHaveLength(2);
  });

  it("renders a plain Shadowrocket node subscription and exposes node multipliers", () => {
    const input = nodes();
    input[0].multiplier_bps = 25000;
    const result = renderSubscription("shadowrocket", input, credential);
    const decoded = Buffer.from(result.body, "base64").toString("utf8");
    expect(decoded).not.toContain("[Rule]");
    expect(decoded).toContain(encodeURIComponent("Test shadowsocks [2.5x]"));
    expect(decoded.split("\n")).toHaveLength(6);
    expect(result.skipped).toEqual([]);
  });

  it("limits Surge to conservative compatible protocols", () => {
    const surge = renderSubscription("surge", nodes(), credential);
    expect(surge.body).toContain("Test shadowsocks");
    expect(surge.body).toContain("Test trojan");
    expect(surge.body).not.toContain("Test vless");
    expect(surge.skipped).toHaveLength(4);
  });

  it("renders six universal URIs in base64", () => {
    const result = renderSubscription("base64", nodes(), credential);
    const decoded = Buffer.from(result.body, "base64").toString("utf8");
    expect(decoded.split("\n")).toHaveLength(6);
    expect(decoded).toContain("vless://");
  });
});
