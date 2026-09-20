import { describe, expect, it } from "vitest";
import YAML from "yaml";
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
    const clashConfig = YAML.parse(clash.body);
    expect(clashConfig["proxy-groups"].map((group: { name: string }) => group.name)).toEqual(expect.arrayContaining([
      "Proxy", "Auto", "🤖 AI", "📹 YouTube", "🍀 Google", "👨‍💻 GitHub", "📲 Telegram", "🎥 Netflix", "🐟 Final",
    ]));
    expect(Object.keys(clashConfig["rule-providers"])).toEqual(expect.arrayContaining([
      "category-ai-!cn-domain", "youtube-domain", "google-domain", "telegram-ip", "netflix-domain", "cn-domain", "cn-ip",
    ]));
    expect(clashConfig.rules).toEqual(expect.arrayContaining([
      "RULE-SET,category-ai-!cn-domain,🤖 AI",
      "RULE-SET,microsoft@cn-domain,DIRECT",
      "RULE-SET,geolocation-!cn-domain,Proxy",
      "RULE-SET,cn-ip,DIRECT,no-resolve",
      "MATCH,🐟 Final",
    ]));
    const singboxConfig = JSON.parse(singbox.body);
    expect(singboxConfig.outbounds.filter((outbound: { server?: string }) => outbound.server)).toHaveLength(6);
    expect(singboxConfig.outbounds.map((outbound: { tag: string }) => outbound.tag)).toEqual(expect.arrayContaining([
      "Proxy", "Auto", "AI", "YouTube", "Google", "GitHub", "Telegram", "Netflix", "Final", "direct",
    ]));
    expect(singboxConfig.route.final).toBe("Final");
    expect(singboxConfig.route.rule_set).toHaveLength(27);
    expect(singboxConfig.route.rules).toEqual(expect.arrayContaining([
      { rule_set: "geosite-category-ai-!cn", outbound: "AI" },
      { rule_set: "geosite-microsoft@cn", outbound: "direct" },
      { rule_set: "geosite-geolocation-!cn", outbound: "Proxy" },
      { rule_set: ["geosite-cn", "geoip-cn"], outbound: "direct" },
    ]));
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

  it("keeps rule targets valid when a subscription has no nodes", () => {
    const clashConfig = YAML.parse(renderSubscription("clash", [], credential).body);
    expect(clashConfig["proxy-groups"].find((group: { name: string }) => group.name === "Proxy").proxies).toEqual(["DIRECT"]);

    const singboxConfig = JSON.parse(renderSubscription("singbox", [], credential).body);
    expect(singboxConfig.outbounds.map((outbound: { tag: string }) => outbound.tag)).toEqual(expect.arrayContaining(["Proxy", "Final", "direct"]));
    expect(singboxConfig.outbounds.some((outbound: { tag: string }) => outbound.tag === "Auto")).toBe(false);
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
