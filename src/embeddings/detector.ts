import { EmbeddingProvider, getDefaultModelForProvider, EmbeddingModelInfo } from "../config/schema.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface ProviderCredentials {
  provider: EmbeddingProvider;
  apiKey?: string;
  baseUrl?: string;
  refreshToken?: string;
  accessToken?: string;
  tokenExpires?: number;
}

export interface DetectedProvider {
  provider: EmbeddingProvider;
  credentials: ProviderCredentials;
  modelInfo: EmbeddingModelInfo;
}

const EMBEDDING_CAPABLE_PROVIDERS: EmbeddingProvider[] = [
  "github-copilot",
  "github",
  "openai",
  "google",
  "ollama",
];

export async function detectEmbeddingProvider(
  preferredProvider?: EmbeddingProvider
): Promise<DetectedProvider> {
  if (preferredProvider && preferredProvider !== "auto") {
    const credentials = await getProviderCredentials(preferredProvider);
    if (credentials) {
      return {
        provider: preferredProvider,
        credentials,
        modelInfo: getDefaultModelForProvider(preferredProvider),
      };
    }
    throw new Error(
      `Preferred provider '${preferredProvider}' is not configured or authenticated`
    );
  }

  for (const provider of EMBEDDING_CAPABLE_PROVIDERS) {
    const credentials = await getProviderCredentials(provider);
    if (credentials) {
      return {
        provider,
        credentials,
        modelInfo: getDefaultModelForProvider(provider),
      };
    }
  }

  throw new Error(
    `No embedding-capable provider found. Please configure one of: ${EMBEDDING_CAPABLE_PROVIDERS.join(", ")}. ` +
      `Set GITHUB_TOKEN, OPENAI_API_KEY, GOOGLE_API_KEY, or ensure Ollama is running.`
  );
}

async function getProviderCredentials(
  provider: EmbeddingProvider
): Promise<ProviderCredentials | null> {
  switch (provider) {
    case "github-copilot":
      return getGitHubCopilotCredentials();
    case "github":
      return getGitHubCredentials();
    case "openai":
      return getOpenAICredentials();
    case "google":
      return getGoogleCredentials();
    case "ollama":
      return getOllamaCredentials();
    default:
      return null;
  }
}

interface OpenCodeAuth {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  enterpriseUrl?: string;
}

function getGitHubCopilotCredentials(): ProviderCredentials | null {
  const authPath = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
  
  try {
    if (!fs.existsSync(authPath)) {
      return null;
    }
    
    const authData = JSON.parse(fs.readFileSync(authPath, "utf-8")) as Record<string, OpenCodeAuth>;
    const copilotAuth = authData["github-copilot"] || authData["github-copilot-enterprise"];
    
    if (!copilotAuth || copilotAuth.type !== "oauth") {
      return null;
    }
    
    const baseUrl = copilotAuth.enterpriseUrl
      ? `https://copilot-api.${copilotAuth.enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
      : "https://api.githubcopilot.com";
    
    return {
      provider: "github-copilot",
      baseUrl,
      refreshToken: copilotAuth.refresh,
      accessToken: copilotAuth.access,
      tokenExpires: copilotAuth.expires,
    };
  } catch {
    return null;
  }
}

function getGitHubCredentials(): ProviderCredentials | null {
  const token =
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    readGitHubTokenFromConfig();

  if (token) {
    return {
      provider: "github",
      apiKey: token,
      baseUrl: "https://models.inference.ai.azure.com",
    };
  }

  return null;
}

function readGitHubTokenFromConfig(): string | null {
  const configPaths = [
    path.join(os.homedir(), ".config", "gh", "hosts.yml"),
    path.join(os.homedir(), ".config", "github-copilot", "hosts.json"),
  ];

  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, "utf-8");
        
        if (configPath.endsWith(".yml")) {
          const match = content.match(/oauth_token:\s*(.+)/);
          if (match) return match[1].trim();
        }
        
        if (configPath.endsWith(".json")) {
          const data = JSON.parse(content);
          const host = data["github.com"];
          if (host?.oauth_token) return host.oauth_token;
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

function getOpenAICredentials(): ProviderCredentials | null {
  const apiKey = process.env.OPENAI_API_KEY;

  if (apiKey) {
    return {
      provider: "openai",
      apiKey,
      baseUrl: "https://api.openai.com/v1",
    };
  }

  return null;
}

function getGoogleCredentials(): ProviderCredentials | null {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

  if (apiKey) {
    return {
      provider: "google",
      apiKey,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    };
  }

  return null;
}

async function getOllamaCredentials(): Promise<ProviderCredentials | null> {
  const baseUrl = process.env.OLLAMA_HOST || "http://localhost:11434";

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json() as { models?: Array<{ name: string }> };
      const hasEmbeddingModel = data.models?.some(
        (m: { name: string }) =>
          m.name.includes("nomic-embed") ||
          m.name.includes("mxbai-embed") ||
          m.name.includes("all-minilm")
      );

      if (hasEmbeddingModel) {
        return {
          provider: "ollama",
          baseUrl,
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function getProviderDisplayName(provider: EmbeddingProvider): string {
  switch (provider) {
    case "github-copilot":
      return "GitHub Copilot";
    case "github":
      return "GitHub (Azure OpenAI)";
    case "openai":
      return "OpenAI";
    case "google":
      return "Google (Gemini)";
    case "ollama":
      return "Ollama (Local)";
    default:
      return provider;
  }
}
