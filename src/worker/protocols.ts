import YAML from "yaml";
import type { NodeRow, Protocol } from "./types";

type Config = Record<string, unknown>;
type Credential = { uuid: string; secret: string };

const METHODS = new Set(["aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305", "2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm"]);
const TRANSPORTS = new Set(["tcp", "ws", "grpc"]);

function text(value: unknown, name: string, required = true): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${name} 不能为空`);
    return undefined;
  }
  if (typeof value !== "string" || value.length > 512) throw new Error(`${name} 格式不正确`);
  return value;
}

function integer(value: unknown, name: string, min = 1, max = 65535): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} 必须在 ${min}-${max} 之间`);
  return parsed;
}

function bool(value: unknown): boolean { return value === true; }

function common(input: Config) {
  return {
    server: text(input.server, "服务器地址")!,
    port: integer(input.port, "端口"),
    udp: input.udp !== false,
  };
}

function transport(input: Config) {
  const value = String(input.transport || "tcp");
  if (!TRANSPORTS.has(value)) throw new Error("传输方式仅支持 tcp、ws 或 grpc");
  return {
    transport: value,
    path: text(input.path, "路径", false),
    host: text(input.host, "Host", false),
    serviceName: text(input.serviceName, "gRPC Service Name", false),
  };
}

export function validateNodeConfig(protocol: Protocol, raw: unknown): Config {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("节点配置必须是对象");
  const input = raw as Config;
  const base = common(input);
  switch (protocol) {
    case "shadowsocks": {
      const method = text(input.method, "加密方式")!;
      if (!METHODS.has(method)) throw new Error("不支持该 Shadowsocks 加密方式");
      return { ...base, method, plugin: text(input.plugin, "插件", false), pluginOpts: text(input.pluginOpts, "插件参数", false) };
    }
    case "vmess":
      return { ...base, ...transport(input), tls: bool(input.tls), sni: text(input.sni, "SNI", false), alterId: integer(input.alterId ?? 0, "alterId", 0, 64) };
    case "vless":
      return { ...base, ...transport(input), tls: bool(input.tls), sni: text(input.sni, "SNI", false), flow: text(input.flow, "Flow", false), realityPublicKey: text(input.realityPublicKey, "Reality 公钥", false), shortId: text(input.shortId, "Reality Short ID", false) };
    case "trojan":
      return { ...base, ...transport(input), sni: text(input.sni, "SNI", false), skipCertVerify: bool(input.skipCertVerify) };
    case "hysteria2":
      return { ...base, sni: text(input.sni, "SNI", false), obfs: text(input.obfs, "混淆方式", false), obfsPassword: text(input.obfsPassword, "混淆密码", false), upMbps: integer(input.upMbps ?? 100, "上行速率", 1, 100000), downMbps: integer(input.downMbps ?? 100, "下行速率", 1, 100000), insecure: bool(input.insecure) };
    case "tuic":
      return { ...base, sni: text(input.sni, "SNI", false), congestionControl: text(input.congestionControl || "bbr", "拥塞控制")!, udpRelayMode: text(input.udpRelayMode || "native", "UDP 模式")!, insecure: bool(input.insecure) };
  }
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function query(values: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "" && value !== false) params.set(key, String(value));
  const result = params.toString();
  return result ? `?${result}` : "";
}

function displayName(node: NodeRow): string {
  const multiplier = Number(node.multiplier_bps || 10000) / 10000;
  return multiplier === 1 ? node.name : `${node.name} [${Number(multiplier.toFixed(2))}x]`;
}

function clashNode(node: NodeRow, config: Config, credential: Credential): Config {
  const base = { name: displayName(node), type: node.protocol === "shadowsocks" ? "ss" : node.protocol, server: config.server, port: config.port, udp: config.udp };
  switch (node.protocol) {
    case "shadowsocks": return { ...base, cipher: config.method, password: credential.secret, plugin: config.plugin, "plugin-opts": config.pluginOpts };
    case "vmess": return { ...base, uuid: credential.uuid, alterId: config.alterId, cipher: "auto", tls: config.tls, servername: config.sni, network: config.transport, "ws-opts": config.transport === "ws" ? { path: config.path || "/", headers: config.host ? { Host: config.host } : undefined } : undefined, "grpc-opts": config.transport === "grpc" ? { "grpc-service-name": config.serviceName || "" } : undefined };
    case "vless": return { ...base, uuid: credential.uuid, tls: config.tls, servername: config.sni, flow: config.flow, network: config.transport, "reality-opts": config.realityPublicKey ? { "public-key": config.realityPublicKey, "short-id": config.shortId || "" } : undefined, "ws-opts": config.transport === "ws" ? { path: config.path || "/", headers: config.host ? { Host: config.host } : undefined } : undefined };
    case "trojan": return { ...base, password: credential.secret, sni: config.sni, "skip-cert-verify": config.skipCertVerify, network: config.transport, "ws-opts": config.transport === "ws" ? { path: config.path || "/", headers: config.host ? { Host: config.host } : undefined } : undefined };
    case "hysteria2": return { ...base, password: credential.secret, sni: config.sni, obfs: config.obfs, "obfs-password": config.obfsPassword, up: `${config.upMbps} Mbps`, down: `${config.downMbps} Mbps`, "skip-cert-verify": config.insecure };
    case "tuic": return { ...base, uuid: credential.uuid, password: credential.secret, sni: config.sni, "congestion-controller": config.congestionControl, "udp-relay-mode": config.udpRelayMode, "skip-cert-verify": config.insecure };
  }
}

function singboxNode(node: NodeRow, config: Config, credential: Credential): Config {
  const base = { type: node.protocol, tag: displayName(node), server: config.server, server_port: config.port };
  const tls = config.tls || ["trojan", "hysteria2", "tuic"].includes(node.protocol)
    ? { enabled: true, server_name: config.sni || config.server, insecure: config.insecure || config.skipCertVerify }
    : undefined;
  const transportValue = config.transport && config.transport !== "tcp" ? { type: config.transport, path: config.path, headers: config.host ? { Host: config.host } : undefined, service_name: config.serviceName } : undefined;
  switch (node.protocol) {
    case "shadowsocks": return { ...base, method: config.method, password: credential.secret };
    case "vmess": return { ...base, uuid: credential.uuid, security: "auto", alter_id: config.alterId, tls, transport: transportValue };
    case "vless": return { ...base, uuid: credential.uuid, flow: config.flow, tls: config.realityPublicKey ? { ...tls, reality: { enabled: true, public_key: config.realityPublicKey, short_id: config.shortId } } : tls, transport: transportValue };
    case "trojan": return { ...base, password: credential.secret, tls, transport: transportValue };
    case "hysteria2": return { ...base, password: credential.secret, up_mbps: config.upMbps, down_mbps: config.downMbps, obfs: config.obfs ? { type: config.obfs, password: config.obfsPassword } : undefined, tls };
    case "tuic": return { ...base, uuid: credential.uuid, password: credential.secret, congestion_control: config.congestionControl, udp_relay_mode: config.udpRelayMode, tls };
  }
}

function uri(node: NodeRow, config: Config, credential: Credential): string {
  const host = `${config.server}:${config.port}`;
  const tag = `#${encodeURIComponent(displayName(node))}`;
  switch (node.protocol) {
    case "shadowsocks": return `ss://${encodeBase64(`${config.method}:${credential.secret}`).replace(/=+$/, "")}@${host}${tag}`;
    case "vmess": return `vmess://${encodeBase64(JSON.stringify({ v: "2", ps: displayName(node), add: config.server, port: String(config.port), id: credential.uuid, aid: String(config.alterId || 0), scy: "auto", net: config.transport, type: "none", host: config.host || "", path: config.path || "", tls: config.tls ? "tls" : "", sni: config.sni || "" }))}`;
    case "vless": return `vless://${credential.uuid}@${host}${query({ encryption: "none", security: config.realityPublicKey ? "reality" : config.tls ? "tls" : "none", type: config.transport, sni: config.sni, flow: config.flow, pbk: config.realityPublicKey, sid: config.shortId, path: config.path, host: config.host })}${tag}`;
    case "trojan": return `trojan://${encodeURIComponent(credential.secret)}@${host}${query({ security: "tls", sni: config.sni, type: config.transport, path: config.path, host: config.host, allowInsecure: config.skipCertVerify ? 1 : undefined })}${tag}`;
    case "hysteria2": return `hysteria2://${encodeURIComponent(credential.secret)}@${host}${query({ sni: config.sni, obfs: config.obfs, "obfs-password": config.obfsPassword, insecure: config.insecure ? 1 : undefined })}${tag}`;
    case "tuic": return `tuic://${credential.uuid}:${encodeURIComponent(credential.secret)}@${host}${query({ sni: config.sni, congestion_control: config.congestionControl, udp_relay_mode: config.udpRelayMode, allow_insecure: config.insecure ? 1 : undefined })}${tag}`;
  }
}

export function renderSubscription(target: string, nodes: NodeRow[], credential: Credential) {
  const parsed = nodes.map((node) => ({ node, config: JSON.parse(node.config_json) as Config }));
  if (target === "clash") {
    const proxies = parsed.map(({ node, config }) => clashNode(node, config, credential));
    const names = proxies.map((proxy) => String(proxy.name));
    const groups = names.length ? [
      { name: "Proxy", type: "select", proxies: ["Auto", ...names, "DIRECT"] },
      { name: "Auto", type: "url-test", proxies: names, url: "https://www.gstatic.com/generate_204", interval: 300 },
    ] : [{ name: "Proxy", type: "select", proxies: ["DIRECT"] }];
    return { body: YAML.stringify({
      "mixed-port": 7890, "allow-lan": false, mode: "rule", "log-level": "info", proxies,
      "proxy-groups": groups,
      rules: ["GEOIP,CN,DIRECT", "MATCH,Proxy"],
    }), contentType: "text/yaml; charset=utf-8", skipped: [] as string[] };
  }
  if (target === "singbox") {
    const nodeOutbounds = parsed.map(({ node, config }) => singboxNode(node, config, credential));
    const tags = nodeOutbounds.map((outbound) => String(outbound.tag));
    const routingOutbounds: Config[] = tags.length ? [
      { type: "selector", tag: "Proxy", outbounds: ["Auto", ...tags, "direct"] },
      { type: "urltest", tag: "Auto", outbounds: tags, url: "https://www.gstatic.com/generate_204", interval: "5m" },
      { type: "direct", tag: "direct" },
    ] : [{ type: "direct", tag: "Proxy" }];
    return { body: JSON.stringify({
      outbounds: [...nodeOutbounds, ...routingOutbounds],
      route: {
        rules: [{ action: "sniff" }, { ip_is_private: true, outbound: "direct" }, { rule_set: ["geosite-cn", "geoip-cn"], outbound: "direct" }],
        rule_set: [
          { type: "remote", tag: "geosite-cn", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs", download_detour: "Proxy" },
          { type: "remote", tag: "geoip-cn", format: "binary", url: "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs", download_detour: "Proxy" },
        ],
        final: "Proxy",
      },
    }, null, 2), contentType: "application/json; charset=utf-8", skipped: [] as string[] };
  }
  if (target === "surge") {
    const supported = parsed.filter(({ node }) => node.protocol === "shadowsocks" || node.protocol === "trojan");
    const skipped = parsed.filter(({ node }) => node.protocol !== "shadowsocks" && node.protocol !== "trojan").map(({ node }) => node.name);
    const lines = supported.map(({ node, config }) => node.protocol === "shadowsocks"
      ? `${node.name} = ss, ${config.server}, ${config.port}, encrypt-method=${config.method}, password=${credential.secret}, udp-relay=true`
      : `${node.name} = trojan, ${config.server}, ${config.port}, password=${credential.secret}, sni=${config.sni || config.server}, skip-cert-verify=${config.skipCertVerify ? "true" : "false"}`);
    return { body: `[Proxy]\n${lines.join("\n")}\n`, contentType: "text/plain; charset=utf-8", skipped };
  }
  if (target === "shadowrocket") {
    return { body: encodeBase64(parsed.map(({ node, config }) => uri(node, config, credential)).join("\n")), contentType: "text/plain; charset=utf-8", skipped: [] as string[] };
  }
  if (target === "base64") {
    return { body: encodeBase64(parsed.map(({ node, config }) => uri(node, config, credential)).join("\n")), contentType: "text/plain; charset=utf-8", skipped: [] as string[] };
  }
  throw new Error("target 仅支持 clash、shadowrocket、singbox、surge 或 base64");
}
