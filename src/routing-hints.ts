import type { StatusResult } from "./indexer/index.js";

export type RoutingIntent =
  | "local_conceptual"
  | "definition_lookup"
  | "exact_identifier"
  | "external"
  | "direct_path"
  | "other";

export interface RoutingAssessment {
  intent: RoutingIntent;
  text: string;
  reason: string;
}

export interface RoutingSessionState {
  assessment: RoutingAssessment;
  pendingHint: boolean;
  updatedAt: number;
}

interface TextPartLike {
  type?: string;
  text?: string;
}

const EXTERNAL_HINTS = [
  "docs",
  "documentation",
  "official docs",
  "github example",
  "github examples",
  "github repo",
  "github repository",
  "web search",
  "website",
  "url",
  "npm",
  "pypi",
  "crate",
  "library",
  "package",
  "framework",
  "context7",
  "stackoverflow",
];

const NON_DISCOVERY_HINTS = [
  "commit",
  "rebase",
  "push",
  "pull request",
  "pr",
  "lint",
  "typecheck",
  "build",
  "test",
  "release",
  "deploy",
  "screenshot",
  "browser",
  "open the website",
];

const CONCEPTUAL_DISCOVERY_HINTS = [
  "where is",
  "where are",
  "which file",
  "what file",
  "how does",
  "how do we",
  "how is",
  "find the code",
  "find code",
  "find where",
  "find logic",
  "implementation",
  "implements",
  "handler",
  "flow",
  "logic",
  "middleware",
  "parser",
  "validation",
  "rate limiting",
  "error handling",
  "auth flow",
  "responsible for",
  "similar code",
  "pattern",
  "code that",
];

const DEFINITION_HINTS = [
  "defined",
  "definition",
  "jump to",
  "definition site",
  "authoritative definition",
];

const EXACT_MATCH_HINTS = [
  "exact",
  "all references",
  "all occurrences",
  "literal",
  "regex",
  "grep",
  "identifier",
  "symbol",
  "named",
  "definition of",
];

const FILE_PATH_PATTERN = /(?:^|\s)(?:\.?\.?\/)?[\w.-]+(?:\/[\w.-]+)+/;
const URL_PATTERN = /https?:\/\//;
const CAMEL_OR_PASCAL_PATTERN = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
const SNAKE_PATTERN = /\b[a-z0-9]+_[a-z0-9_]+\b/g;
const KEBAB_PATTERN = /\b[a-z0-9]+-[a-z0-9-]+\b/g;
const BACKTICK_IDENTIFIER_PATTERN = /`([^`]+)`/g;

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function includesHint(text: string, hints: string[]): boolean {
  return hints.some((hint) => text.includes(hint));
}

function countWords(text: string): number {
  if (!text) {
    return 0;
  }

  return text.split(/\s+/).filter(Boolean).length;
}

function hasIdentifierShape(text: string): boolean {
  const matches = [
    ...(text.match(CAMEL_OR_PASCAL_PATTERN) ?? []),
    ...(text.match(SNAKE_PATTERN) ?? []),
    ...(text.match(KEBAB_PATTERN) ?? []),
    ...Array.from(text.matchAll(BACKTICK_IDENTIFIER_PATTERN), (match) => match[1]),
  ];

  return matches.some((match) => {
    if (match.length < 3) {
      return false;
    }

    return /[A-Z]/.test(match) || match.includes("_") || match.includes("-") || /`/.test(text);
  });
}

function containsQuotedIdentifier(text: string): boolean {
  return BACKTICK_IDENTIFIER_PATTERN.test(text) || /"[^"]+"/.test(text) || /'[^']+'/.test(text);
}

function looksLikeDirectPath(text: string): boolean {
  return FILE_PATH_PATTERN.test(text) || /\b[a-z0-9_-]+\.(ts|tsx|js|jsx|rs|py|go|java|json|md|yaml|yml)\b/i.test(text);
}

export function extractUserText(parts: TextPartLike[]): string {
  return normalizeText(
    parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join(" "),
  );
}

export function assessRoutingIntent(text: string): RoutingAssessment {
  const normalizedText = normalizeText(text);
  const lowered = normalizedText.toLowerCase();

  if (!lowered) {
    return {
      intent: "other",
      text: normalizedText,
      reason: "empty_text",
    };
  }

  if (URL_PATTERN.test(lowered) || includesHint(lowered, EXTERNAL_HINTS)) {
    return {
      intent: "external",
      text: normalizedText,
      reason: "external_lookup",
    };
  }

  const hasConceptualHint = includesHint(lowered, CONCEPTUAL_DISCOVERY_HINTS);
  const hasDefinitionHint = includesHint(lowered, DEFINITION_HINTS);
  const hasExactMatchHint = includesHint(lowered, EXACT_MATCH_HINTS);
  const hasNonDiscoveryHint = includesHint(lowered, NON_DISCOVERY_HINTS);
  const hasIdentifier = hasIdentifierShape(normalizedText);
  const hasQuotedIdentifier = containsQuotedIdentifier(normalizedText);
  const shortQuery = countWords(lowered) <= 10;

  if (hasNonDiscoveryHint && !hasConceptualHint) {
    return {
      intent: "other",
      text: normalizedText,
      reason: "non_discovery_task",
    };
  }

  if (looksLikeDirectPath(normalizedText)) {
    return {
      intent: "direct_path",
      text: normalizedText,
      reason: "direct_path_reference",
    };
  }

  if ((hasDefinitionHint || lowered.includes("where is") || lowered.includes("where are")) && (lowered.includes("defined") || lowered.includes("definition"))) {
    return {
      intent: "definition_lookup",
      text: normalizedText,
      reason: "definition_lookup_request",
    };
  }

  if ((hasExactMatchHint || hasQuotedIdentifier || hasIdentifier) && !hasConceptualHint && shortQuery) {
    return {
      intent: "exact_identifier",
      text: normalizedText,
      reason: hasExactMatchHint || hasQuotedIdentifier ? "exact_match_request" : "identifier_shaped_query",
    };
  }

  if (hasConceptualHint) {
    return {
      intent: "local_conceptual",
      text: normalizedText,
      reason: "conceptual_local_discovery",
    };
  }

  return {
    intent: "other",
    text: normalizedText,
    reason: "no_local_discovery_signal",
  };
}

export function buildRoutingHint(
  assessment: RoutingAssessment,
  status: Pick<StatusResult, "indexed" | "compatibility"> | null,
): string | null {
  if (assessment.intent === "definition_lookup") {
    if (!status || !status.indexed || status.compatibility?.compatible === false) {
      return "For this turn, if you need a symbol definition, check `index_status` first and run `index_codebase` if the index is missing or incompatible. Then use `implementation_lookup` for the definition site. Use `grep` for exhaustive literal matches.";
    }

    return "For this turn, prefer `implementation_lookup` to find the authoritative definition site. Use `codebase_search` only if no definition is found, and use `grep` for exhaustive literal matches.";
  }

  if (assessment.intent !== "local_conceptual") {
    return null;
  }

  if (!status || !status.indexed || status.compatibility?.compatible === false) {
    return "For this turn, if local code discovery by behavior is needed, check `index_status` first and run `index_codebase` if the index is missing or incompatible. Use `grep` for exact identifiers or exhaustive matches.";
  }

  return "For this turn, prefer `codebase_peek` for local code discovery by behavior or likely location, then use `codebase_search` when you need implementation content. Use `grep` for exact identifiers or exhaustive matches.";
}

export class RoutingHintController {
  private readonly sessionState = new Map<string, RoutingSessionState>();

  constructor(
    private readonly getStatus: () => Promise<Pick<StatusResult, "indexed" | "compatibility">>,
    private readonly maxSessions: number = 200,
  ) {}

  observeUserMessage(sessionID: string, parts: TextPartLike[]): RoutingAssessment {
    const assessment = assessRoutingIntent(extractUserText(parts));

    this.compactSessions();
    this.sessionState.set(sessionID, {
      assessment,
      pendingHint: assessment.intent === "local_conceptual" || assessment.intent === "definition_lookup",
      updatedAt: Date.now(),
    });

    return assessment;
  }

  async getSystemHints(sessionID?: string): Promise<string[]> {
    if (!sessionID) {
      return [];
    }

    const state = this.sessionState.get(sessionID);
    if (!state || !state.pendingHint) {
      return [];
    }

    const status = await this.safeGetStatus();
    const hint = buildRoutingHint(state.assessment, status);

    return hint ? [hint] : [];
  }

  markToolUsed(sessionID: string, toolName: string): void {
    const state = this.sessionState.get(sessionID);
    if (!state || !state.pendingHint) {
      return;
    }

    if (
      toolName === "codebase_peek"
      || toolName === "codebase_search"
      || toolName === "implementation_lookup"
      || toolName === "index_status"
      || toolName === "index_codebase"
    ) {
      state.pendingHint = false;
      state.updatedAt = Date.now();
      this.sessionState.set(sessionID, state);
    }
  }

  getSessionState(sessionID: string): RoutingSessionState | undefined {
    return this.sessionState.get(sessionID);
  }

  private async safeGetStatus(): Promise<Pick<StatusResult, "indexed" | "compatibility"> | null> {
    try {
      return await this.getStatus();
    } catch {
      return null;
    }
  }

  private compactSessions(): void {
    if (this.sessionState.size < this.maxSessions) {
      return;
    }

    const oldestSession = [...this.sessionState.entries()]
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
      .at(0);

    if (oldestSession) {
      this.sessionState.delete(oldestSession[0]);
    }
  }
}
