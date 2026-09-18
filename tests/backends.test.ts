import { describe, expect, it } from "vitest";
import { BACKEND_RECOGNITION_CODE, parseBackendManifest, parseGitHubRepository, renderPresetConfig, sha256Hex } from "../src/worker/backends";

const manifest = {
  recognitionCode: BACKEND_RECOGNITION_CODE,
  schemaVersion: 1,
  backendId: "com.example.agent",
  name: "Example Agent",
  version: "1.0.0",
  panelApiVersion: "v1",
  install: { script: "scripts/install.sh", sha256: "a".repeat(64) },
  presets: [{
    id: "vless-reality", name: "VLESS Reality", protocol: "vless", description: "test",
    config: { server: "{{ input.server }}", port: 443, publicKey: "{{ generated.publicKey }}" },
    inputs: [{ key: "server", label: "节点地址", type: "hostname", placeholder: "node.example.com", help: "公网地址", installArg: "--domain" }], generatedOutputs: ["publicKey"],
  }],
};

function readme(value: unknown = manifest) {
  return `<!-- ${BACKEND_RECOGNITION_CODE} -->\n<!-- boardless:backend:start -->\n\`\`\`json boardless-backend\n${JSON.stringify(value)}\n\`\`\`\n<!-- boardless:backend:end -->`;
}

describe("backend repository manifests", () => {
  it("parses a valid manifest and renders declared inputs", () => {
    const parsed = parseBackendManifest(readme());
    expect(parsed.backendId).toBe("com.example.agent");
    expect(parsed.presets[0].inputs).toEqual([{ key: "server", label: "节点地址", type: "hostname", placeholder: "node.example.com", help: "公网地址", installArg: "--domain", required: true }]);
    expect(renderPresetConfig(parsed.presets[0].config, { server: "node.example.com" })).toEqual({ server: "node.example.com", port: 443, publicKey: "{{ generated.publicKey }}" });
    expect(renderPresetConfig(parsed.presets[0].config, { server: "node.example.com" }, { publicKey: "pub" })).toEqual({ server: "node.example.com", port: 443, publicKey: "pub" });
  });

  it("keeps legacy requiredInputs compatible but rejects invalid menu metadata", () => {
    const legacyPresets = [{ ...manifest.presets[0], inputs: undefined, requiredInputs: ["server"] }];
    expect(parseBackendManifest(readme({ ...manifest, presets: legacyPresets })).presets[0].inputs).toEqual([{ key: "server", label: "server", type: "text", required: true }]);
    const invalidPresets = [{ ...manifest.presets[0], inputs: [{ key: "mode", label: "模式", type: "select", options: [] }], config: { mode: "{{ input.mode }}" } }];
    expect(() => parseBackendManifest(readme({ ...manifest, presets: invalidPresets }))).toThrow("options");
  });

  it("parses conditional checkbox and sensitive installation fields", () => {
    const presets = [{ ...manifest.presets[0], inputs: [
      ...manifest.presets[0].inputs,
      { key: "enableVps", label: "同步 VPS Panel", type: "checkbox", required: false, default: "false", installArg: "--mode", checkedValue: "both", uncheckedValue: "boardless" },
      { key: "token", label: "注册令牌", type: "password", installArg: "--vps-token", when: { key: "enableVps", equals: "true" } },
    ] }];
    const parsed = parseBackendManifest(readme({ ...manifest, presets }));
    expect(parsed.presets[0].inputs[1]).toMatchObject({ type: "checkbox", required: false, checkedValue: "both" });
    expect(parsed.presets[0].inputs[2]).toMatchObject({ sensitive: true, when: { key: "enableVps", equals: "true" } });
    const leaking = [{ ...presets[0], config: { ...presets[0].config, leaked: "{{ input.token }}" } }];
    expect(() => parseBackendManifest(readme({ ...manifest, presets: leaking }))).toThrow("只能用于安装参数");
  });

  it("rejects undeclared templates and unsafe script paths", () => {
    expect(() => parseBackendManifest(readme({ ...manifest, install: { ...manifest.install, script: "../install.sh" } }))).toThrow("相对路径");
    const presets = [{ ...manifest.presets[0], config: { server: "{{ input.undeclared }}" } }];
    expect(() => parseBackendManifest(readme({ ...manifest, presets }))).toThrow("未声明输入");
    const privatePreset = [{ ...manifest.presets[0], generatedOutputs: ["realityPrivateKey"], config: { key: "{{ generated.realityPrivateKey }}" } }];
    expect(() => parseBackendManifest(readme({ ...manifest, presets: privatePreset }))).toThrow("只能声明公开字段");
  });

  it("accepts only canonical public GitHub repository URLs", () => {
    expect(parseGitHubRepository("https://github.com/example/agent.git")).toEqual({ owner: "example", repository: "agent", repositoryUrl: "https://github.com/example/agent" });
    expect(() => parseGitHubRepository("https://example.com/example/agent")).toThrow();
    expect(() => parseGitHubRepository("https://github.com/example/agent/tree/main")).toThrow();
  });

  it("computes hexadecimal SHA-256", async () => {
    expect(await sha256Hex("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});
