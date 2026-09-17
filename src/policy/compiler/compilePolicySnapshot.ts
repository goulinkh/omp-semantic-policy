import { createHash } from "node:crypto";
import type { PolicySnapshot, PolicyVersionTuple } from "../snapshots/types.js";
import type {
  CompiledPolicyRule,
  InstructionSource,
  LocalPathProhibition,
  PolicyRuleApplicability,
  PolicyRuleClass,
} from "../sources/types.js";

export const POLICY_COMPILER_VERSION = "instruction-compiler-v3";

export interface CompilePolicySnapshotOptions {
  readonly projectRoot: string;
  readonly sources: readonly InstructionSource[];
  readonly versions: Omit<PolicyVersionTuple, "compiler"> & { readonly compiler?: string };
  readonly createdAtMs?: number;
}

/** Compile source text into a stable, provenance-preserving immutable snapshot. */
export function compilePolicySnapshot(options: CompilePolicySnapshotOptions): PolicySnapshot {
  const sources = [...options.sources].sort(
    (left, right) => left.precedence - right.precedence || left.path.localeCompare(right.path),
  );
  const rules = sources.flatMap(compileSource);
  const versions: PolicyVersionTuple = {
    compiler: options.versions.compiler ?? POLICY_COMPILER_VERSION,
    question: options.versions.question,
    thresholds: options.versions.thresholds,
    model: options.versions.model,
  };
  const identity = {
    schemaVersion: 1,
    projectRoot: options.projectRoot,
    versions,
    sources: sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      path: source.path,
      scopeRoot: source.scopeRoot,
      contentDigest: source.contentDigest,
      precedence: source.precedence,
    })),
    rules,
  };

  return {
    schemaVersion: 1,
    id: digestJson(identity),
    projectRoot: options.projectRoot,
    createdAtMs: options.createdAtMs ?? Date.now(),
    versions,
    sources,
    rules,
  };
}

function compileSource(source: InstructionSource): CompiledPolicyRule[] {
  const statements = extractContextualStatements(source.content);
  return statements.map(({ statement, context, introduction }, index) => {
    const applicability = inferApplicability(statement, context, introduction);
    const localEnforcement = compileLocalProhibition(statement, context, statements);
    return {
      id: digestJson({ sourceId: source.id, index, statement, context }),
      sourceId: source.id,
      sourceKind: source.kind,
      scopeRoot: source.scopeRoot,
      classification: classifyStatement(statement),
      statement,
      precedence: source.precedence,
      ...(context.length === 0 ? {} : { context }),
      ...(applicability === undefined ? {} : { applicability }),
      ...(localEnforcement === undefined ? {} : { localEnforcement }),
    };
  });
}

interface ContextualStatement {
  readonly statement: string;
  readonly context: readonly string[];
  readonly listItem?: boolean;
  readonly introduction?: string;
  readonly listSection?: number;
}

/** Retain instructions and ambiguous prose, but not fenced examples or obvious descriptions. */
export function extractStatements(content: string): readonly string[] {
  return extractContextualStatements(content).map((entry) => entry.statement);
}

function extractContextualStatements(content: string): readonly ContextualStatement[] {
  const statements: ContextualStatement[] = [];
  let current: string[] = [];
  let headings: { readonly depth: number; readonly title: string }[] = [];
  let fence: string | undefined;
  let listItem = false;
  let listSection = 0;

  const flush = () => {
    const statement = current.join(" ").replace(/\s+/gu, " ").trim();
    if (statement.length > 0) {
      statements.push({
        statement,
        context: headings.map((heading) => heading.title),
        listSection,
        ...(listItem ? { listItem: true } : {}),
      });
    }
    current = [];
    listItem = false;
  };

  for (const rawLine of content.split(/\r?\n/gu)) {
    const line = rawLine.trim();
    const fenceMatch = line.match(/^(`{3,}|~{3,})/u)?.[1];
    if (fenceMatch !== undefined) {
      flush();
      listSection += 1;
      if (fence === undefined) {
        fence = fenceMatch;
      } else if (fenceMatch[0] === fence[0] && fenceMatch.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) {
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/u);
    if (heading !== null) {
      flush();
      listSection += 1;
      const depth = heading[1]?.length ?? 1;
      headings = headings.filter((entry) => entry.depth < depth);
      if (/^(?:never|must|shall|do not|don't|you (?:must|should))\s+/iu.test(heading[2] ?? "")) {
        statements.push({
          statement: heading[2] ?? "",
          context: headings.map((entry) => entry.title),
        });
      }
      headings.push({ depth, title: heading[2] ?? "" });
      continue;
    }
    if (line.length === 0 || /^(?:---+|\*\*\*+|___+)$/u.test(line)) {
      flush();
      continue;
    }
    const bullet = line.match(/^(?:[-*+] |\d+[.)] )(.*)$/u);
    if (bullet !== null) {
      flush();
      listItem = true;
      current.push((bullet[1] ?? "").replace(/^\[[ xX]\]\s*/u, ""));
      continue;
    }
    current.push(line);
  }
  flush();
  const grouped: ContextualStatement[] = [];
  for (let index = 0; index < statements.length; index += 1) {
    const entry = statements[index];
    if (entry === undefined) {
      continue;
    }
    const items = [entry.statement];
    if (!entry.listItem && entry.statement.endsWith(":")) {
      while (
        statements[index + 1]?.listItem &&
        statements[index + 1]?.listSection === entry.listSection &&
        statements[index + 1]?.context.join("\n") === entry.context.join("\n")
      ) {
        index += 1;
        const item = statements[index];
        if (item !== undefined) {
          items.push(item.statement);
        }
      }
    }
    const statement = items.join(" ");
    const introduction = items.length > 1 ? entry.statement : undefined;
    if (!isObviousDescription(statement, introduction)) {
      grouped.push({
        statement,
        context: entry.context,
        ...(introduction === undefined ? {} : { introduction }),
      });
    }
  }
  return grouped;
}

function isObviousDescription(statement: string, introduction?: string): boolean {
  if (/^examples?:$/iu.test(statement)) {
    return true;
  }
  if (/^(?:import\s+.+\s+from\s+["']|(?:export\s+)?(?:const|let|var)\s+\w+\s*=)/u.test(statement)) {
    return true;
  }
  if (
    introduction !== undefined &&
    /^(?:the implemented\s+`?\w+`?|(?:a|the)\s+(?:snapshot|evaluation context|policy action|action|record|schema))\s+(?:(?:is immutable and )?includes|records|contains|carries|lists)\b/iu.test(
      introduction,
    ) &&
    !/\b(?:must|never|shall|should|required|prohibited|forbid\w*|do not|don't|unless|except|only|allowed|permitted|immutable)\b/iu.test(
      statement,
    )
  ) {
    return true;
  }
  // A small positive description grammar avoids silently dropping unfamiliar constraints.
  if (
    /[.!?]\s+\S|\b(?:must|never|shall|should|required|prohibited|forbid\w*|avoid|prefer|may|can|allowed|permitted|except|unless|do not|don't|always|only|no|restrict\w*|protect\w*|deny|block\w*)\b/iu.test(
      statement,
    )
  ) {
    return false;
  }
  return (
    /^\[[^\]]+\]\([^)]+\)\.?$/u.test(statement) ||
    /^(?:this|the)\s+(?:project|repository|document|file|module|package|directory|section|example|table|diagram)\s+(?:is|contains|provides|describes|documents|illustrates|shows|lists|uses|includes)\b/iu.test(
      statement,
    ) ||
    /^(?:for example|e\.g\.)[:,]/iu.test(statement) ||
    /^(?:\|?\s*:?-{3,}:?\s*)+\|?$/u.test(statement)
  );
}

function inferApplicability(
  statement: string,
  context: readonly string[],
  introduction?: string,
): PolicyRuleApplicability | undefined {
  if (isImplementationRequirement(statement, context, introduction)) {
    return { phase: "implementation" };
  }
  // Exceptions, permissions, and compound/cross-cutting bans stay together in full context.
  if (
    /\b(?:never|must not|do not|don't|shall not|prohibited|forbidden|unless|except|may|can|allowed|permitted|override)\b/iu.test(
      statement,
    )
  ) {
    return undefined;
  }
  if (/[;]|\.\s+\S|\b(?:and|but|also)\b/iu.test(statement)) {
    // A phase marker in one clause does not scope unrelated obligations.
    return undefined;
  }
  const completion =
    /\b(?:before (?:yielding|completing|finishing|responding)|before (?:the )?final (?:response|answer)|at (?:task )?completion|when (?:the task is )?(?:complete|finished))\b/iu;
  const completionHeading =
    /^(?:completion|delivery|final (?:response|answer)|before (?:yielding|completing)|verification before (?:completion|delivery))$/iu;
  if (
    completion.test(statement) ||
    (context.some((heading) => completionHeading.test(heading)) &&
      /^(?:run|verify|ensure|report|summarize|include|check|finish|complete|remove|update|return|provide|deliver|present|state)\b/iu.test(
        statement,
      ))
  ) {
    return { phase: "completion" };
  }
  // Heading scope alone must not hide hard constraints on shell/delegated behavior.
  if (
    /^(?:when|while)\s+(?:writing|editing|implementing|refactoring)\s+(?:code|tests?|typescript)\b/iu.test(
      statement,
    ) ||
    (context.some((heading) =>
      /^(?:typescript standards|code style|naming and files|implementation)$/iu.test(heading),
    ) &&
      /^(?:use|prefer|name|keep|model|define|write|implement|extract|document)\b/iu.test(statement))
  ) {
    return { phase: "implementation" };
  }
  return undefined;
}

function isImplementationRequirement(
  statement: string,
  context: readonly string[],
  introduction: string | undefined,
): boolean {
  if (/\bbefore (?:yielding|completing|finishing|responding|(?:the )?final)\b/iu.test(statement)) {
    return false;
  }
  const codeContext = context.some((heading) =>
    /\b(?:code|typescript|testing|implementation|architecture|compiler|dependencies|public API|entrypoint|commit|documentation|test layers|naming and files)\b/iu.test(
      heading,
    ),
  );
  // Explicit list subjects bind their operands. A provider's responsibilities
  // and cases a test must cover are not commands for an unrelated shell action.
  if (
    introduction !== undefined &&
    (/^(?:before (?:creating a commit|committing)|(?:at minimum, )?(?:preserve|maintain|add|write|keep) tests for|the (?:runtime|integration|test) matrix must (?:eventually )?verify):$/iu.test(
      introduction,
    ) ||
      (codeContext &&
        (/^(?:the|a|an) (?:[\w-]+ ){0,3}(?:engine|adapter|module|schema|record|interface|class|function|component|integration)(?: is [^:.;]+)?:$/iu.test(
          introduction,
        ) ||
          /^(?:the implemented\s+`?\w+`?|(?:a|the)\s+(?:snapshot|evaluation context|policy action|action|record|schema))\s+(?:(?:is immutable and )?includes|records|contains|carries|lists):$/iu.test(
            introduction,
          ) ||
          /^(?:compiled\s+)?(?:instructions|rules|decisions|actions)\s+(?:use|have|include)\s+(?:\w+\s+)?(?:behavioral\s+)?(?:classes|categories|variants):$/iu.test(
            introduction,
          ) ||
          /^required integration capabilities include:$/iu.test(introduction))))
  ) {
    return true;
  }
  // These constraints can govern today's action as well as the code being built.
  // Never hide them merely because they occur in a coding-standards document.
  if (
    /\b(?:credentials?|secrets?|passwords?|api[ -]keys?|tokens?|authorization|authentication|environment values?|protect\w*|encrypt\w*|unredacted|redact\w*|egress|policy bypass|sandbox|unavailable|fail.open|denials?)\b|agent\.db/iu.test(
      statement,
    )
  ) {
    return false;
  }
  const artifact =
    /\b(?:typescript|compiler options?|discriminated unions?|unions?|types?|type casts?|constructors?|assertions?|variants?|interfaces?|functions?|methods?|classes|modules?|imports?|exports?|exported|entry\s?points?|loaders?|code|implementations?|dependencies|packages?|barrels?|aliases|APIs?|SDKs?|schemas?|migrations?|tests?|fixtures?|mocks?|regressions?|bug fix(?:es)?|reproducers?|test suites?|TSDoc|comments?|source links|issue references|commits?|commit messages?|pull requests?|lockfiles|semantic versioning|policy engine|provider adapters?|public contracts?|policy database|runtime validation|boundary errors?|fallback values|source records|snapshots|project discovery|provider calls)\b/iu;
  const artifactSubject =
    /^(?:(?:the|a|an|each|every)\s+)?(?:policy engine|provider adapter|OMP (?:adapter|event module)|function|module|public contract|snapshot|policy database|compiler|schema|test|fixture|API|TSDoc|`[^`]+`)\b/iu.test(
      statement,
    );
  if (
    !codeContext &&
    !artifactSubject &&
    !/^(?:use|write|name|define|implement|document|export|import)\b/iu.test(statement)
  ) {
    return false;
  }
  // A prohibition has to identify a recognized code-construction operation.
  // Unknown bans remain applicable, including when bundled with an artifact rule.
  const prohibitions = statement.matchAll(
    /\b(?:never|do not|don't|must not|shall not|cannot|forbid\w*|prohibit\w*|bann?ed)\b[^.;]*/giu,
  );
  for (const [clause] of prohibitions) {
    if (
      !/^(?:never|do not|don't|must not|shall not)\s+(?:use|add|create|export|import|weaken|split|mix|mutate|place|duplicate|mock|test|preserve|optimize|rely|repeat|pin|write|maintain)\b/iu.test(
        clause,
      ) ||
      !artifact.test(clause) ||
      /\b(?:read|send|upload|publish|release|reveal|print|execute|spawn|delete|log|persist|commit|push)\b/iu.test(
        clause,
      )
    ) {
      return false;
    }
  }
  // Lists belong to their introduction: test cases and dependency lists are not
  // freestanding instructions to perform every listed operation right now.
  if (
    introduction !== undefined &&
    (artifact.test(introduction) ||
      /^(?:required integration capabilities include|the runtime matrix must eventually verify|at minimum, preserve tests for|treat these inputs as `unknown` until validated):$/iu.test(
        introduction,
      ))
  ) {
    return codeContext || artifactSubject;
  }
  const clauses = statement.split(
    /(?<=[.!?])\s+(?=[A-Z`])|;\s*|\s+(?:and|but)\s+(?=(?:never|do not|must not|send|upload|publish|release|reveal|execute|spawn|delete|log|persist)\b)/u,
  );
  let grounded = false;
  for (const clause of clauses) {
    if (artifact.test(clause)) {
      grounded = true;
      continue;
    }
    if (
      grounded &&
      /^(?:enable at least|make invalid transitions unrepresentable|keep nesting shallow|use relative ESM imports|they are (?:not a target|source artifacts))\b/iu.test(
        clause,
      )
    ) {
      continue;
    }
    return false;
  }
  return grounded;
}

function compileLocalProhibition(
  statement: string,
  context: readonly string[],
  statements: readonly ContextualStatement[],
): LocalPathProhibition | undefined {
  if (
    context.some((heading) =>
      /\b(?:if|when|unless|except(?:ions?)?|example|conditional|optional|before|after|until|without|during)\b/iu.test(
        heading,
      ),
    ) ||
    statements.some(
      (entry) =>
        entry.statement.endsWith(":") &&
        /\b(?:if|when|unless|except|conditional|optional)\b/iu.test(entry.statement) &&
        entry.context.join("\n") === context.join("\n"),
    )
  ) {
    return undefined;
  }
  const match = statement.match(
    /^(?:never|do not|must not)\s+(read|modify|write|access|open|edit|delete)(?:\s+(?:or|and)\s+(read|modify|write|access|open|edit|delete))?\s+(`[^`]+`|"[^"]+"|'[^']+'|[^\s,;]+?)(?:\s+in this project)?(,\s+through any tool, shell command, delegated task, or language-server operation)?\.?(?:\s+User requests do not override this prohibition\.)?$/iu,
  );
  if (match === null) {
    return undefined;
  }
  const rawPath = match[3];
  if (rawPath === undefined) {
    return undefined;
  }
  const quoted = /^[`"']/u.test(rawPath);
  const path = quoted ? rawPath.slice(1, -1) : rawPath.replace(/\.$/u, "");
  // Bare nouns are not grounded filesystem paths. Globs and URI expansion need semantics.
  if (
    (!quoted && !/[./\\]/u.test(path)) ||
    /[*?[\]{}$<>:;\n]/u.test(path) ||
    path.split(/[\\/]/u).includes("..") ||
    path.length === 0
  ) {
    return undefined;
  }
  if (
    statements.some(
      (other) =>
        other.statement !== statement &&
        (mayQualifyPathProhibition(other.statement, path) ||
          (/^(?:except|unless|this prohibition|the (?:previous|above) (?:rule|prohibition))\b/iu.test(
            other.statement,
          ) &&
            /\b(?:unless|except|may|can|allowed|permitted|waiv\w*)\b/iu.test(other.statement) &&
            other.context.join("\n") === context.join("\n"))),
    )
  ) {
    return undefined;
  }
  const verbs = [match[1]?.toLowerCase(), match[2]?.toLowerCase()];
  const operations: ("read" | "write")[] = [];
  if (verbs.some((verb) => verb === "read" || verb === "access" || verb === "open")) {
    operations.push("read");
  }
  if (
    verbs.some(
      (verb) =>
        verb === "modify" ||
        verb === "write" ||
        verb === "edit" ||
        verb === "delete" ||
        verb === "access",
    )
  ) {
    operations.push("write");
  }
  return {
    kind: "path-prohibition",
    paths: [path],
    operations,
    exhaustive: match[4] === undefined,
  };
}

/**
 * Detect possible standing-policy exceptions without mistaking a permission
 * explicitly conditioned on NOT accessing the path for permission to access it.
 * Ambiguous positive permissions still require semantic assessment.
 */
export function mayQualifyPathProhibition(statement: string, path: string): boolean {
  if (
    !/\b(?:unless|except|may|can|allowed|permitted|waiv\w*)\b|(?<!not )(?<!never )\boverride\b/iu.test(
      statement,
    ) ||
    path.length === 0
  ) {
    return false;
  }
  let index = statement.indexOf(path);
  if (index === -1) {
    return false;
  }
  if (/\bunless\b/iu.test(statement)) {
    return true;
  }
  const hasException = /\bexcept\b/iu.test(statement);
  const affirmativeExclusion =
    /\b(?:allowed|permitted|may|can)\b/iu.test(statement) &&
    !/\b(?:never|not|no|without|if|when|forbid\w*|prohibit\w*|deny|cannot|can't|don't|mustn't|shouldn't)\b/iu.test(
      statement,
    );
  while (index !== -1) {
    const prefix = statement.slice(0, index);
    // Permission outside a target cannot waive its protection. Negated or
    // conditional permissions remain ambiguous, as do later direct references.
    const excludedReference =
      affirmativeExclusion &&
      /\b(?:outside|excluding|other than|except(?:\s+for)?)\s+[`"']?$/iu.test(prefix);
    if (
      !excludedReference &&
      (hasException ||
        !/\b(?:does not|do not|must not|never|without)\s+(?:read(?:ing)?|modif(?:y|ying)|writ(?:e|ing)|open(?:ing)?|access(?:ing)?|edit(?:ing)?|delet(?:e|ing))(?:\s+(?:or|and)\s+(?:read|modify|write|open|access|edit|delete))?\s+[`"']?$/iu.test(
          prefix,
        ))
    ) {
      return true;
    }
    index = statement.indexOf(path, index + path.length);
  }
  return false;
}

export function classifyStatement(statement: string): PolicyRuleClass {
  if (
    /\b(?:must(?:\s+not)?|never|do not|don't|shall(?:\s+not)?|prohibited|required)\b/iu.test(
      statement,
    )
  ) {
    return "hard";
  }
  if (
    /\b(?:before|after|then|first|finally|workflow|sequence|before yielding|before completing)\b/iu.test(
      statement,
    )
  ) {
    return "workflow";
  }
  if (/\b(?:should(?:\s+not)?|prefer|recommended|avoid|may)\b/iu.test(statement)) {
    return "advisory";
  }
  return "semantic";
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
