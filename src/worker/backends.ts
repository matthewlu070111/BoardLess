import type { Protocol } from "./types";

export const BACKEND_RECOGNITION_CODE = "BOARDLESS_BACKEND_REPOSITORY_V1";

export interface BackendPreset {
  id: string;
  name: string;
  protocol: Protocol;
  description: string;
  config: Record<string, unknown>;
  requiredInputs: string[];
  generatedOutputs: string[];
}

export interface BackendManifest {
  recognitionCode: typeof BACKEND_RECOGNITION_CODE;
  schemaVersion: 1;
  backendId: string;
  name: string;
  version: string;
  panelApiVersion: "v1";
  install: { script: string; sha256: string; uninstallScript?: string };
  presets: BackendPreset[];
}

export interface ImportedBackend {
  owner: string;
  repository: string;
  repositoryUrl: string;
  requestedRef: string;
  commitSha: string;
  readmePath: string;
  readmeUrl: string;
  installScriptUrl: string;
  readmeHash: string;
  manifest: BackendManifest;
}

const protocols = new Set<Protocol>(["shadowsocks", "vmess", "vless", "trojan", "hysteria2", "tuic"]);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const relativePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const sha256Pattern = /^[a-f0-9]{64}$/i;
const commitPattern = /^[a-f0-9]{40}$/i;

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
  return value as Record<string, unknown>;
}

function shortText(value: unknown, name: string, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} 格式无效`);
  return value.trim();
}

function names(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${name} 必须是数组`);
  const result = value.map((item) => shortText(item, name, 64));
  if (result.some((item) => !identifier.test(item)) || new Set(result).size !== result.length) throw new Error(`${name} 包含无效或重复字段`);
  return result;
}

function safePath(value: unknown, name: string): string {
  const path = shortText(value, name, 240);
  if (!relativePath.test(path) || path.includes("//")) throw new Error(`${name} 必须是仓库内相对路径`);
  return path;
}

function validateTemplates(value: unknown, inputs: Set<string>, generated: Set<string>, depth = 0): void {
  if (depth > 12) throw new Error("预设配置嵌套过深");
  if (typeof value === "string") {
    const expressions = [...value.matchAll(/{{\s*(input|generated)\.([A-Za-z0-9._-]+)\s*}}/g)];
    const stripped = value.replace(/{{\s*(?:input|generated)\.[A-Za-z0-9._-]+\s*}}/g, "");
    if (stripped.includes("{{") || stripped.includes("}}")) throw new Error("预设包含不支持的模板表达式");
    for (const match of expressions) {
      if (match[1] === "input" && !inputs.has(match[2])) throw new Error(`预设引用了未声明输入：${match[2]}`);
      if (match[1] === "generated" && !generated.has(match[2])) throw new Error(`预设引用了未声明生成字段：${match[2]}`);
    }
  } else if (Array.isArray(value)) {
    if (value.length > 100) throw new Error("预设数组过长");
    value.forEach((item) => validateTemplates(item, inputs, generated, depth + 1));
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 100) throw new Error("预设字段过多");
    entries.forEach(([, item]) => validateTemplates(item, inputs, generated, depth + 1));
  }
}

export function parseBackendManifest(readme: string): BackendManifest {
  if (readme.length > 512_000) throw new Error("README 超过 512 KB 限制");
  if (!readme.includes(`<!-- ${BACKEND_RECOGNITION_CODE} -->`)) throw new Error("README 缺少 BoardLess 后端特征识别码");
  const start = "<!-- boardless:backend:start -->";
  const end = "<!-- boardless:backend:end -->";
  if (readme.split(start).length !== 2 || readme.split(end).length !== 2) throw new Error("README 必须包含唯一的后端识别块");
  const block = readme.slice(readme.indexOf(start) + start.length, readme.indexOf(end));
  const match = block.match(/```json\s+boardless-backend\s*\n([\s\S]*?)\n```/);
  if (!match) throw new Error("后端识别块缺少 json boardless-backend 代码段");
  let raw: unknown;
  try { raw = JSON.parse(match[1]); } catch { throw new Error("后端识别块不是有效 JSON"); }
  const source = record(raw, "后端识别块");
  if (source.recognitionCode !== BACKEND_RECOGNITION_CODE) throw new Error("recognitionCode 不匹配");
  if (source.schemaVersion !== 1) throw new Error("仅支持后端 Schema v1");
  if (source.panelApiVersion !== "v1") throw new Error("后端不兼容 BoardLess 节点 API v1");
  const backendId = shortText(source.backendId, "backendId", 128);
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(backendId)) throw new Error("backendId 格式无效");
  const install = record(source.install, "install");
  const script = safePath(install.script, "install.script");
  const digest = shortText(install.sha256, "install.sha256", 64).toLowerCase();
  if (!sha256Pattern.test(digest)) throw new Error("install.sha256 必须是 64 位十六进制 SHA-256");
  const presetsRaw = source.presets;
  if (!Array.isArray(presetsRaw) || !presetsRaw.length || presetsRaw.length > 50) throw new Error("presets 必须包含 1-50 个预设");
  const presets = presetsRaw.map((item, index): BackendPreset => {
    const preset = record(item, `presets[${index}]`);
    const id = shortText(preset.id, `presets[${index}].id`, 64);
    if (!identifier.test(id)) throw new Error(`预设 ID 无效：${id}`);
    if (!protocols.has(preset.protocol as Protocol)) throw new Error(`预设协议不受支持：${String(preset.protocol)}`);
    const requiredInputs = names(preset.requiredInputs, `${id}.requiredInputs`);
    const generatedOutputs = names(preset.generatedOutputs, `${id}.generatedOutputs`);
    if (generatedOutputs.some((field) => /private|secret|password|token/i.test(field))) throw new Error(`${id}.generatedOutputs 只能声明公开字段，不能包含私钥、密码或令牌`);
    const config = record(preset.config, `${id}.config`);
    validateTemplates(config, new Set(requiredInputs), new Set(generatedOutputs));
    return {
      id,
      name: shortText(preset.name, `${id}.name`, 100),
      protocol: preset.protocol as Protocol,
      description: typeof preset.description === "string" ? preset.description.slice(0, 500) : "",
      config,
      requiredInputs,
      generatedOutputs,
    };
  });
  if (new Set(presets.map((preset) => preset.id)).size !== presets.length) throw new Error("预设 ID 不能重复");
  return {
    recognitionCode: BACKEND_RECOGNITION_CODE,
    schemaVersion: 1,
    backendId,
    name: shortText(source.name, "name", 100),
    version: shortText(source.version, "version", 80),
    panelApiVersion: "v1",
    install: {
      script,
      sha256: digest,
      ...(install.uninstallScript ? { uninstallScript: safePath(install.uninstallScript, "install.uninstallScript") } : {}),
    },
    presets,
  };
}

export function parseGitHubRepository(repositoryUrl: string): { owner: string; repository: string; repositoryUrl: string } {
  let url: URL;
  try { url = new URL(repositoryUrl); } catch { throw new Error("GitHub 仓库地址无效"); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash) {
    throw new Error("只允许公开 GitHub HTTPS 仓库地址");
  }
  const parts = url.pathname.replace(/^\/|\/$/g, "").split("/");
  if (parts.length !== 2) throw new Error("GitHub 仓库地址必须是 owner/repository");
  const owner = parts[0];
  const repository = parts[1].replace(/\.git$/i, "");
  if (!identifier.test(owner) || !identifier.test(repository)) throw new Error("GitHub owner 或仓库名无效");
  return { owner, repository, repositoryUrl: `https://github.com/${owner}/${repository}` };
}

async function responseText(url: string, accept: string): Promise<string> {
  const response = await fetch(url, { headers: { Accept: accept, "User-Agent": "BoardLess/1.0" }, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`GitHub 读取失败 (${response.status})`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 1_000_000) throw new Error("GitHub 文件超过 1 MB 限制");
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("GitHub 文件超过 1 MB 限制");
  return text;
}

export async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function importBackendRepository(repositoryUrl: string, requestedRef = "", readmePath = "README.md"): Promise<ImportedBackend> {
  const repositoryInfo = parseGitHubRepository(repositoryUrl);
  const path = safePath(readmePath || "README.md", "readmePath");
  const apiBase = `https://api.github.com/repos/${repositoryInfo.owner}/${repositoryInfo.repository}`;
  let ref = requestedRef.trim();
  if (!ref) {
    const metadata = JSON.parse(await responseText(apiBase, "application/vnd.github+json")) as { default_branch?: string };
    ref = shortText(metadata.default_branch, "GitHub 默认分支", 200);
  }
  if (ref.length > 200 || /[\s~^:?*[\]\\]/.test(ref) || ref.includes("..")) throw new Error("Git ref 格式无效");
  const commit = JSON.parse(await responseText(`${apiBase}/commits/${encodeURIComponent(ref)}`, "application/vnd.github+json")) as { sha?: string };
  if (!commit.sha || !commitPattern.test(commit.sha)) throw new Error("GitHub 未返回有效提交 SHA");
  const commitSha = commit.sha.toLowerCase();
  const rawBase = `https://raw.githubusercontent.com/${repositoryInfo.owner}/${repositoryInfo.repository}/${commitSha}`;
  const readmeUrl = `${rawBase}/${path}`;
  const readme = await responseText(readmeUrl, "text/plain");
  const manifest = parseBackendManifest(readme);
  const installScriptUrl = `${rawBase}/${manifest.install.script}`;
  const scriptResponse = await fetch(installScriptUrl, { headers: { "User-Agent": "BoardLess/1.0" }, signal: AbortSignal.timeout(12_000) });
  if (!scriptResponse.ok) throw new Error(`安装脚本读取失败 (${scriptResponse.status})`);
  const script = await scriptResponse.arrayBuffer();
  if (script.byteLength > 1_000_000) throw new Error("安装脚本超过 1 MB 限制");
  const actualDigest = await sha256Hex(script);
  if (actualDigest !== manifest.install.sha256) throw new Error("安装脚本 SHA-256 与 README 声明不一致");
  return {
    ...repositoryInfo,
    requestedRef: ref,
    commitSha,
    readmePath: path,
    readmeUrl,
    installScriptUrl,
    readmeHash: await sha256Hex(readme),
    manifest,
  };
}

export function renderPresetConfig(value: unknown, inputs: Record<string, string>, generated: Record<string, string> = {}): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^{{\s*(input|generated)\.([A-Za-z0-9._-]+)\s*}}$/);
    if (exact) return (exact[1] === "input" ? inputs : generated)[exact[2]] ?? value;
    return value.replace(/{{\s*(input|generated)\.([A-Za-z0-9._-]+)\s*}}/g, (expression, source: string, key: string) => (source === "input" ? inputs : generated)[key] ?? expression);
  }
  if (Array.isArray(value)) return value.map((item) => renderPresetConfig(item, inputs, generated));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, renderPresetConfig(item, inputs, generated)]));
  return value;
}
