// @bun
// src/policy/compiler/compilePolicySnapshot.ts
import { createHash } from "crypto";
var POLICY_COMPILER_VERSION = "instruction-compiler-v4";
function compilePolicySnapshot(options) {
  const sources = [...options.sources].sort((left, right) => left.precedence - right.precedence || left.path.localeCompare(right.path));
  const rules = sources.flatMap(compileSource);
  const versions = {
    compiler: options.versions.compiler ?? POLICY_COMPILER_VERSION,
    question: options.versions.question,
    thresholds: options.versions.thresholds,
    model: options.versions.model
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
      precedence: source.precedence
    })),
    rules
  };
  return {
    schemaVersion: 1,
    id: digestJson(identity),
    projectRoot: options.projectRoot,
    createdAtMs: options.createdAtMs ?? Date.now(),
    versions,
    sources,
    rules
  };
}
function compileSource(source) {
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
      ...context.length === 0 ? {} : { context },
      ...applicability === undefined ? {} : { applicability },
      ...localEnforcement === undefined ? {} : { localEnforcement }
    };
  });
}
function extractStatements(content) {
  return extractContextualStatements(content).map((entry) => entry.statement);
}
function extractContextualStatements(content) {
  const statements = [];
  let current = [];
  let headings = [];
  let fence;
  let listItem = false;
  let listSection = 0;
  const flush = () => {
    const statement = current.join(" ").replace(/\s+/gu, " ").trim();
    if (statement.length > 0) {
      statements.push({
        statement,
        context: headings.map((heading) => heading.title),
        listSection,
        ...listItem ? { listItem: true } : {}
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
          context: headings.map((entry) => entry.title)
        });
      }
      headings.push({ depth, title: heading[2] ?? "" });
      continue;
    }
    if (line.length === 0 || /^(?:---+|\*\*\*+|___+)$/u.test(line)) {
      flush();
      continue;
    }
    if (/^\|.*\|$/u.test(line)) {
      flush();
      current.push(line);
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
  const grouped = [];
  let introductions = [];
  for (let index = 0;index < statements.length; index += 1) {
    const entry = statements[index];
    if (entry === undefined) {
      continue;
    }
    introductions = introductions.filter((item) => item.headings.length <= entry.context.length && item.headings.every((heading, depth) => heading === entry.context[depth]));
    const items = [entry.statement];
    if (!entry.listItem && entry.statement.endsWith(":")) {
      while (statements[index + 1]?.listItem && statements[index + 1]?.listSection === entry.listSection && statements[index + 1]?.context.join(`
`) === entry.context.join(`
`)) {
        index += 1;
        const item = statements[index];
        if (item !== undefined) {
          items.push(item.statement);
        }
      }
    }
    const statement = items.join(" ");
    const introduction = items.length > 1 ? entry.statement : undefined;
    const context = [...entry.context, ...introductions.map((item) => item.statement)];
    if (!isObviousDescription(statement, introduction, context)) {
      grouped.push({
        statement,
        context,
        ...introduction === undefined ? {} : { introduction }
      });
    }
    if (isScopeIntroduction(entry.statement)) {
      introductions.push({ headings: entry.context, statement: entry.statement });
    }
  }
  return grouped;
}
function isScopeIntroduction(statement) {
  return /^(?:these|the following)\s+(?:rules|restrictions|instructions|requirements|steps)\s+(?:apply|are (?:applicable|limited))\b/iu.test(statement) || /^(?:this|the)\s+(?:procedure|workflow|guide|section)\s+(?:applies|is (?:only )?for)\b/iu.test(statement) || /^(?:if|when|while|during|for|before|after|unless)\b/iu.test(statement) && (statement.endsWith(":") || /\b(?:this|the|a|an)\s+(?:[\w-]+\s+){0,2}(?:procedure|workflow|probe|experiment|benchmark)\b/iu.test(statement));
}
function isObviousDescription(statement, introduction, context = []) {
  if (/^examples?:$/iu.test(statement)) {
    return true;
  }
  if (/^(?:import\s+.+\s+from\s+["']|(?:export\s+)?(?:const|let|var)\s+\w+\s*=)/u.test(statement)) {
    return true;
  }
  if (isHistoricalReport(statement)) {
    return true;
  }
  const cells = statement.startsWith("|") ? statement.slice(1, -1).split("|") : undefined;
  if (cells !== undefined && (cells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell)) || context.some((heading) => /\b(?:history|historical|recorded|results?|observations?|measurements?|evidence|experiments?|smoke)\b/iu.test(heading)) && cells.every((cell) => /^\s*(?:allow|deny|prompt|revise)(?:\s*\/\s*(?:allow|deny|prompt|revise))*\s*$/iu.test(cell) || !hasLiveConstraint(cell.trim())) && cells.some((cell) => /^\s*(?:[\d,./\u00D7% -]+|(?:allow|deny|prompt|revise)(?:\s*\/\s*(?:allow|deny|prompt|revise))*|(?:[\w\u00D7/-]+\s+)*(?:bytes|latency|milliseconds|attempts|repetitions|outcomes?|effects?|aggregate))\s*$/iu.test(cell)))) {
    return true;
  }
  if (/^(?:\[[^\]]+\]\([^)]+\)[\s\u00B7,;|./-]*)+$/u.test(statement)) {
    return true;
  }
  if (!hasLiveConstraint(statement) && statement.split(/(?<=[.!?])\s+/u).every((sentence) => /^(?:(?:this|the)\s+(?:document|file|module|package|directory|section|example|table|diagram)|it)\s+(?:contains|provides|describes|documents|illustrates|shows|lists|includes)\b/iu.test(sentence))) {
    return true;
  }
  if (introduction !== undefined && /^(?:the implemented\s+`?\w+`?|(?:a|the)\s+(?:snapshot|evaluation context|policy action|action|record|schema))\s+(?:(?:is immutable and )?includes|records|contains|carries|lists)\b/iu.test(introduction) && !/\b(?:must|never|shall|should|required|prohibited|forbid\w*|do not|don't|unless|except|only|allowed|permitted|immutable)\b/iu.test(statement)) {
    return true;
  }
  if (/[.!?]\s+\S|\b(?:must|never|shall|should|required|prohibited|forbid\w*|avoid|prefer|may|can|allowed|permitted|except|unless|do not|don't|always|only|no|restrict\w*|protect\w*|deny|block\w*)\b/iu.test(statement)) {
    return false;
  }
  return /^\[[^\]]+\]\([^)]+\)\.?$/u.test(statement) || /^(?:this|the)\s+(?:project|repository|document|file|module|package|directory|section|example|table|diagram)\s+(?:is|contains|provides|describes|documents|illustrates|shows|lists|uses|includes)\b/iu.test(statement) || /^(?:for example|e\.g\.)[:,]/iu.test(statement) || /^(?:\|?\s*:?-{3,}:?\s*)+\|?$/u.test(statement);
}
function isHistoricalReport(statement) {
  if (hasLiveConstraint(statement)) {
    return false;
  }
  return statement.split(/(?<=[.!?])\s+/u).every((sentence) => /^(?:(?:a|an|the|each|every|both|all|our|this|that)\s+(?:[\w`'().,-]+\s+){0,8}|we\s+)(?:evaluated|tested|observed|measured|recorded|reported|matched|completed|assessed|cited|used|loaded|exercised|denied|allowed|prohibited|blocked|were|was|had)\b/iu.test(sentence));
}
function hasLiveConstraint(statement) {
  return /\b(?:must|never|shall|should|do not|don't|cannot|can't|mustn't|shouldn't|may|unless|except|required|forbidden)\b/iu.test(statement) || /\b(?:is|are|remains?)\s+(?:\w+\s+){0,2}(?:prohibited|forbidden|required|allowed|permitted|restricted)\b/iu.test(statement) || /(?:^|[.!?;:]\s+)(?:always|only|no|avoid|prefer|keep|use|run|verify|ensure|retain|do|protect|restrict|require|forbid|deny|block|allow|permit|if|when|before|after)\b/iu.test(statement) || /\b(?:forbids|prohibits|requires|restricts|permits|allows|stays?|remains?)\b/iu.test(statement);
}
function inferApplicability(statement, context, introduction) {
  if (isImplementationRequirement(statement, context, introduction)) {
    return { phase: "implementation" };
  }
  if (/\b(?:never|must not|do not|don't|shall not|prohibited|forbidden|unless|except|may|can|allowed|permitted|override)\b/iu.test(statement)) {
    return;
  }
  if (/[;]|\.\s+\S|\b(?:and|but|also)\b/iu.test(statement)) {
    return;
  }
  const completion = /\b(?:before (?:yielding|completing|finishing|responding)|before (?:the )?final (?:response|answer)|at (?:task )?completion|when (?:the task is )?(?:complete|finished))\b/iu;
  const completionHeading = /^(?:completion|delivery|final (?:response|answer)|before (?:yielding|completing)|verification before (?:completion|delivery))$/iu;
  if (completion.test(statement) || context.some((heading) => completionHeading.test(heading)) && /^(?:run|verify|ensure|report|summarize|include|check|finish|complete|remove|update|return|provide|deliver|present|state)\b/iu.test(statement)) {
    return { phase: "completion" };
  }
  if (/^(?:when|while)\s+(?:writing|editing|implementing|refactoring)\s+(?:code|tests?|typescript)\b/iu.test(statement) || context.some((heading) => /^(?:typescript standards|code style|naming and files|implementation)$/iu.test(heading)) && /^(?:use|prefer|name|keep|model|define|write|implement|extract|document)\b/iu.test(statement)) {
    return { phase: "implementation" };
  }
  return;
}
function isImplementationRequirement(statement, context, introduction) {
  if (/\bbefore (?:yielding|completing|finishing|responding|(?:the )?final)\b/iu.test(statement)) {
    return false;
  }
  const codeContext = context.some((heading) => /\b(?:code|typescript|testing|implementation|architecture|compiler|dependencies|public API|entrypoint|commit|documentation|test layers|naming and files)\b/iu.test(heading));
  if (introduction !== undefined && (/^(?:before (?:creating a commit|committing)|(?:at minimum, )?(?:preserve|maintain|add|write|keep) tests for|the (?:runtime|integration|test) matrix must (?:eventually )?verify):$/iu.test(introduction) || codeContext && (/^(?:the|a|an) (?:[\w-]+ ){0,3}(?:engine|adapter|module|schema|record|interface|class|function|component|integration)(?: is [^:.;]+)?:$/iu.test(introduction) || /^(?:the implemented\s+`?\w+`?|(?:a|the)\s+(?:snapshot|evaluation context|policy action|action|record|schema))\s+(?:(?:is immutable and )?includes|records|contains|carries|lists):$/iu.test(introduction) || /^(?:compiled\s+)?(?:instructions|rules|decisions|actions)\s+(?:use|have|include)\s+(?:\w+\s+)?(?:behavioral\s+)?(?:classes|categories|variants):$/iu.test(introduction) || /^required integration capabilities include:$/iu.test(introduction)))) {
    return true;
  }
  if (/\b(?:credentials?|secrets?|passwords?|api[ -]keys?|tokens?|authorization|authentication|environment values?|protect\w*|encrypt\w*|unredacted|redact\w*|egress|policy bypass|sandbox|unavailable|fail.open|denials?)\b|agent\.db/iu.test(statement)) {
    return false;
  }
  const artifact = /\b(?:typescript|compiler options?|discriminated unions?|unions?|types?|type casts?|constructors?|assertions?|variants?|interfaces?|functions?|methods?|classes|modules?|imports?|exports?|exported|entry\s?points?|loaders?|code|implementations?|dependencies|packages?|barrels?|aliases|APIs?|SDKs?|schemas?|migrations?|tests?|fixtures?|mocks?|regressions?|bug fix(?:es)?|reproducers?|test suites?|TSDoc|comments?|source links|issue references|commits?|commit messages?|pull requests?|lockfiles|semantic versioning|policy engine|provider adapters?|public contracts?|policy database|runtime validation|boundary errors?|fallback values|source records|snapshots|project discovery|provider calls)\b/iu;
  const artifactSubject = /^(?:(?:the|a|an|each|every)\s+)?(?:policy engine|provider adapter|OMP (?:adapter|event module)|function|module|public contract|snapshot|policy database|compiler|schema|test|fixture|API|TSDoc|`[^`]+`)\b/iu.test(statement);
  if (!codeContext && !artifactSubject && !/^(?:use|write|name|define|implement|document|export|import)\b/iu.test(statement)) {
    return false;
  }
  const prohibitions = statement.matchAll(/\b(?:never|do not|don't|must not|shall not|cannot|forbid\w*|prohibit\w*|bann?ed)\b[^.;]*/giu);
  for (const [clause] of prohibitions) {
    if (!/^(?:never|do not|don't|must not|shall not)\s+(?:use|add|create|export|import|weaken|split|mix|mutate|place|duplicate|mock|test|preserve|optimize|rely|repeat|pin|write|maintain)\b/iu.test(clause) || !artifact.test(clause) || /\b(?:read|send|upload|publish|release|reveal|print|execute|spawn|delete|log|persist|commit|push)\b/iu.test(clause)) {
      return false;
    }
  }
  if (introduction !== undefined && (artifact.test(introduction) || /^(?:required integration capabilities include|the runtime matrix must eventually verify|at minimum, preserve tests for|treat these inputs as `unknown` until validated):$/iu.test(introduction))) {
    return codeContext || artifactSubject;
  }
  const clauses = statement.split(/(?<=[.!?])\s+(?=[A-Z`])|;\s*|\s+(?:and|but)\s+(?=(?:never|do not|must not|send|upload|publish|release|reveal|execute|spawn|delete|log|persist)\b)/u);
  let grounded = false;
  for (const clause of clauses) {
    if (artifact.test(clause)) {
      grounded = true;
      continue;
    }
    if (grounded && /^(?:enable at least|make invalid transitions unrepresentable|keep nesting shallow|use relative ESM imports|they are (?:not a target|source artifacts))\b/iu.test(clause)) {
      continue;
    }
    return false;
  }
  return grounded;
}
function compileLocalProhibition(statement, context, statements) {
  if (context.some((heading) => isScopeIntroduction(heading) || /\b(?:if|when|unless|except(?:ions?)?|example|conditional|optional|before|after|until|without|during|procedure|workflow|probe|experiment|benchmark|tuning|maintenance|setup|cleanup|installation|deployment|migration)\b/iu.test(heading)) || statements.some((entry) => entry.statement.endsWith(":") && /\b(?:if|when|unless|except|conditional|optional)\b/iu.test(entry.statement) && entry.context.join(`
`) === context.join(`
`))) {
    return;
  }
  const match = statement.match(/^(?:never|do not|must not)\s+(read|modify|write|access|open|edit|delete)(?:\s+(?:or|and)\s+(read|modify|write|access|open|edit|delete))?\s+(`[^`]+`|"[^"]+"|'[^']+'|[^\s,;]+?)(?:\s+in this project)?(,\s+through any tool, shell command, delegated task, or language-server operation)?\.?(?:\s+User requests do not override this prohibition\.)?$/iu);
  if (match === null) {
    return;
  }
  const rawPath = match[3];
  if (rawPath === undefined) {
    return;
  }
  const quoted = /^[`"']/u.test(rawPath);
  const path = quoted ? rawPath.slice(1, -1) : rawPath.replace(/\.$/u, "");
  if (!quoted && !/[./\\]/u.test(path) || /[*?[\]{}$<>:;\n]/u.test(path) || path.split(/[\\/]/u).includes("..") || path.length === 0) {
    return;
  }
  if (statements.some((other) => other.statement !== statement && (mayQualifyPathProhibition(other.statement, path) || /^(?:except|unless|this prohibition|the (?:previous|above) (?:rule|prohibition))\b/iu.test(other.statement) && /\b(?:unless|except|may|can|allowed|permitted|waiv\w*)\b/iu.test(other.statement) && other.context.join(`
`) === context.join(`
`)))) {
    return;
  }
  const verbs = [match[1]?.toLowerCase(), match[2]?.toLowerCase()];
  const operations = [];
  if (verbs.some((verb) => verb === "read" || verb === "access" || verb === "open")) {
    operations.push("read");
  }
  if (verbs.some((verb) => verb === "modify" || verb === "write" || verb === "edit" || verb === "delete" || verb === "access")) {
    operations.push("write");
  }
  return {
    kind: "path-prohibition",
    paths: [path],
    operations,
    exhaustive: match[4] === undefined
  };
}
function mayQualifyPathProhibition(statement, path) {
  if (!/\b(?:unless|except|may|can|allowed|permitted|waiv\w*)\b|(?<!not )(?<!never )\boverride\b/iu.test(statement) || path.length === 0) {
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
  const affirmativeExclusion = /\b(?:allowed|permitted|may|can)\b/iu.test(statement) && !/\b(?:never|not|no|without|if|when|forbid\w*|prohibit\w*|deny|cannot|can't|don't|mustn't|shouldn't)\b/iu.test(statement);
  while (index !== -1) {
    const prefix = statement.slice(0, index);
    const excludedReference = affirmativeExclusion && /\b(?:outside|excluding|other than|except(?:\s+for)?)\s+[`"']?$/iu.test(prefix);
    if (!excludedReference && (hasException || !/\b(?:does not|do not|must not|never|without)\s+(?:read(?:ing)?|modif(?:y|ying)|writ(?:e|ing)|open(?:ing)?|access(?:ing)?|edit(?:ing)?|delet(?:e|ing))(?:\s+(?:or|and)\s+(?:read|modify|write|open|access|edit|delete))?\s+[`"']?$/iu.test(prefix))) {
      return true;
    }
    index = statement.indexOf(path, index + path.length);
  }
  return false;
}
function classifyStatement(statement) {
  if (/\b(?:must(?:\s+not)?|never|do not|don't|shall(?:\s+not)?|prohibited|required)\b/iu.test(statement)) {
    return "hard";
  }
  if (/\b(?:before|after|then|first|finally|workflow|sequence|before yielding|before completing)\b/iu.test(statement)) {
    return "workflow";
  }
  if (/\b(?:should(?:\s+not)?|prefer|recommended|avoid|may)\b/iu.test(statement)) {
    return "advisory";
  }
  return "semantic";
}
function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
// src/policy/gate/createConservativeFallback.ts
var NON_MUTATING_OPERATIONS = {
  read: true,
  workflow: true
};
function createConservativeFallback() {
  return {
    id: "conservative-unconfigured-policy",
    evaluate(action) {
      if (NON_MUTATING_OPERATIONS[action.operation] === true) {
        return { effect: "allow", ruleIds: ["fallback.allow-non-mutating"] };
      }
      return {
        effect: "prompt",
        reason: `The semantic evaluator is unavailable, so this ${action.operation} action was not classified as compliant or noncompliant. Explicit approval is required before ${action.hostAction.name} can run.`,
        ruleIds: ["fallback.prompt-side-effect"]
      };
    }
  };
}
// src/policy/gate/createPolicyGate.ts
function createPolicyGate(options) {
  const deterministicEvaluators = [...options.deterministicEvaluators];
  const semanticEvaluator = options.semanticEvaluator;
  const fallbackEvaluator = options.fallbackEvaluator;
  return {
    async evaluate(action, context, signal) {
      signal?.throwIfAborted();
      for (const evaluator of deterministicEvaluators) {
        const draft = await evaluator.evaluate(action, context, signal);
        signal?.throwIfAborted();
        if (draft !== undefined) {
          return finalizeDecision(draft, evaluator.id, evaluator.source);
        }
      }
      if (semanticEvaluator !== undefined) {
        const draft = await semanticEvaluator.evaluate(action, context, signal);
        signal?.throwIfAborted();
        if (draft !== undefined) {
          return finalizeDecision(draft, semanticEvaluator.id, semanticEvaluator.source);
        }
      }
      const fallback = await fallbackEvaluator.evaluate(action, context, signal);
      signal?.throwIfAborted();
      return finalizeDecision(fallback, fallbackEvaluator.id, "fallback");
    }
  };
}
function finalizeDecision(draft, evaluatorId, source) {
  const evidence = {
    evaluatorId,
    source,
    ruleIds: draft.ruleIds === undefined ? [] : [...draft.ruleIds]
  };
  switch (draft.effect) {
    case "allow":
      return { effect: "allow", evidence };
    case "prompt":
      return { effect: "prompt", reason: draft.reason, evidence };
    case "deny":
      return { effect: "deny", reason: draft.reason, evidence };
    case "revise":
      return { effect: "revise", input: { ...draft.input }, reason: draft.reason, evidence };
  }
}
// src/policy/snapshots/staleness.ts
import { basename, isAbsolute, relative, resolve, sep } from "path";
var INSTRUCTION_FILENAMES = {
  "AGENTS.md": true,
  "CLAUDE.md": true
};
function actionMayMutatePolicySources(action, snapshot) {
  if (action.operation !== "write" && action.operation !== "execute") {
    return false;
  }
  const knownSourcePaths = new Set(snapshot.sources.map((source) => resolve(source.path)));
  return action.targets.some((target) => {
    if (target.kind !== "path" || hasProtocol(target.value)) {
      return false;
    }
    const candidate = resolve(isAbsolute(target.value) ? target.value : resolve(action.workingDirectory, target.value));
    if (!isPathWithin(snapshot.projectRoot, candidate)) {
      return false;
    }
    return knownSourcePaths.has(candidate) || INSTRUCTION_FILENAMES[basename(candidate)] === true;
  });
}
function hasProtocol(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(value);
}
function isPathWithin(root, candidate) {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || !pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..";
}
// src/policy/sources/selectApplicableSources.ts
import { isAbsolute as isAbsolute2, relative as relative2, resolve as resolve2, sep as sep2 } from "path";
function selectApplicableSources(sources, action) {
  const pathTargets = action.targets.filter((target) => target.kind === "path" && !hasProtocol2(target.value)).map((target) => isAbsolute2(target.value) ? target.value : resolve2(action.workingDirectory, target.value));
  const isProjectWorkflow = action.operation === "workflow";
  return sources.filter((source) => {
    if (source.kind !== "subtree" || isProjectWorkflow) {
      return true;
    }
    return pathTargets.some((target) => isPathWithin2(source.scopeRoot, target));
  }).sort((left, right) => left.precedence - right.precedence || left.path.localeCompare(right.path));
}
function hasProtocol2(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(value);
}
function isPathWithin2(root, candidate) {
  const pathFromRoot = relative2(resolve2(root), resolve2(candidate));
  return pathFromRoot === "" || !pathFromRoot.startsWith(`..${sep2}`) && pathFromRoot !== "..";
}
// src/policy/sources/selectApplicableRules.ts
import { isAbsolute as isAbsolute3, relative as relative3, resolve as resolve3, sep as sep3 } from "path";
import { fileURLToPath } from "url";
function selectApplicableRules(snapshot, action) {
  let hasPathPattern = false;
  const paths = action.targets.flatMap((target) => {
    if (target.kind !== "path") {
      return [];
    }
    const values = action.hostAction.name === "grep" || action.hostAction.name === "glob" ? target.value.split(";") : [target.value];
    return values.flatMap((value) => {
      const path = resolveLocalPolicyPath(value, action.workingDirectory, true);
      if (path === undefined) {
        return [];
      }
      const wildcard = path.search(/[*?[\]{}]/u);
      if (wildcard !== -1) {
        hasPathPattern = true;
        return [path.slice(0, path.lastIndexOf(sep3, wildcard)) || sep3];
      }
      return [path];
    });
  });
  const opaque = action.operation === "execute" || action.operation === "delegate" || action.operation === "unknown";
  const treeInspection = hasPathPattern || action.hostAction.name === "grep" || action.hostAction.name === "glob";
  if (paths.length === 0 && (opaque || treeInspection)) {
    paths.push(resolve3(action.workingDirectory));
  }
  const implementationAction = action.operation !== "read" && action.operation !== "internal" && action.operation !== "network" && !isOperationalShellAction(action);
  return snapshot.rules.filter((rule) => {
    if (rule.sourceKind === "subtree" && action.operation !== "workflow") {
      const overlaps = paths.some((path) => isPolicyPathWithin(rule.scopeRoot, path) || (opaque || treeInspection) && isPolicyPathWithin(path, rule.scopeRoot));
      if (!overlaps && !opaque) {
        return false;
      }
    }
    if (rule.applicability?.phase === "completion") {
      return action.operation === "workflow" && action.hostAction.name !== "ask" && action.hostAction.name !== "todo";
    }
    if (rule.applicability?.phase === "implementation") {
      return implementationAction;
    }
    return true;
  });
}
function resolveLocalPolicyPath(value, workingDirectory, allowPattern = false) {
  let path = value.trim();
  if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      return;
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(path)) {
    return;
  }
  path = path.split(/:|\?(?=[^/?]*=)/u)[0] ?? "";
  try {
    path = decodeURIComponent(path);
  } catch {
    return;
  }
  if (path.length === 0 || /\0/u.test(path) || !allowPattern && /[*?[\]{}]/u.test(path)) {
    return;
  }
  return isAbsolute3(path) ? resolve3(path) : resolve3(workingDirectory, path);
}
function isPolicyPathWithin(root, candidate) {
  const fromRoot = relative3(resolve3(root), resolve3(candidate));
  return fromRoot === "" || !isAbsolute3(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep3}`);
}
function isOperationalShellAction(action) {
  if (!action.complete || action.operation !== "execute" || action.hostAction.name !== "bash" && action.hostAction.name !== "user_bash" || action.hostAction.input.env !== undefined) {
    return false;
  }
  const shell = action.details.shellPayload;
  if (shell !== null && typeof shell === "object" && !Array.isArray(shell) && "syntax" in shell && shell.syntax === "direct-curl" && "assessment" in shell && shell.assessment === "complete") {
    return true;
  }
  const command = action.hostAction.input.command;
  if (typeof command !== "string" || /[\r\n]/u.test(command)) {
    return false;
  }
  return command.trim().split(/\s*&&\s*/u).every((part) => /^(?:(?:bun|node|npm|npx|pnpm|yarn|python(?:3)?|git|tsc|rustc|cargo)\s+--version|node\s+-v|(?:git|go|cargo)\s+version|pwd|git\s+status(?:\s+--(?:short|porcelain))?|git\s+diff\s+--(?:stat|name-only)|bun\s+install(?:\s+--frozen-lockfile)?|omp\s+plugin\s+link\s+\.)$/u.test(part));
}
export {
  POLICY_COMPILER_VERSION,
  actionMayMutatePolicySources,
  classifyStatement,
  compilePolicySnapshot,
  createConservativeFallback,
  createPolicyGate,
  extractStatements,
  selectApplicableRules,
  selectApplicableSources
};
