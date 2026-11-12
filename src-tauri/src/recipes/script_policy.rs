//! The script policy: which `script` rules a shared recipe (bundled, community or imported) may carry. The
//! contract is `docs/wiki/script-policy.md`; the tables are `shared/script-policy/policy.json`.
//!
//! The scanner parses the exact wrapped text the page runs with oxc, serializes the tree to ESTree
//! JSON and walks it with explicit roles (statement, expression, binding, assignment target,
//! callee, member object). Anything not named in the tables is refused.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use oxc_allocator::Allocator;
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

pub const MAX_CODE_BYTES: usize = 16 * 1024;
pub const MAX_SCRIPT_RULES: usize = 8;
pub const MAX_TOTAL_CODE_BYTES: usize = 32 * 1024;

const WRAPPER_PREFIX: &str = "(function(){\"use strict\";\n";
const WRAPPER_SUFFIX: &str = "\n})";
const POLICY_JSON: &str = include_str!("../../../shared/script-policy/policy.json");

/// oxc and the JSON reader recurse once per tree level, and a 16 KiB script can nest tens of
/// thousands of levels without a single bracket (`a+a+a+…`), so every parse and walk runs on a
/// thread with a stack that holds the worst case. Only touched pages are committed. Measured with
/// 16 KiB inputs (`1+`, `!`, `.b`, `a?b:`, `a=>`, `if(a)` chains) in a debug build: 16 MiB overflows,
/// 20 MiB passes; 80 MiB is 4x that (release frames are smaller).
const SCAN_STACK_BYTES: usize = 80 * 1024 * 1024;

const SYNTAX: &str = "syntax";
const SIZE: &str = "size";
const TEXT: &str = "text";
const NESTING: &str = "nesting";
const HTML_COMMENT: &str = "html-comment";
const NOT_ALLOWED: &str = "syntax-not-allowed";
const GLOBAL_NOT_ALLOWED: &str = "global-not-allowed";
const MEMBER_NOT_ALLOWED: &str = "member-not-allowed";
const COMPUTED: &str = "computed-access";
const BAD_ARGUMENT: &str = "bad-argument";
const BAD_WRITE: &str = "bad-write";
const INSERT: &str = "insert-not-allowed";
const REGEX: &str = "regex";
const NAVIGATION: &str = "navigation";
const CODE_NAMES: [&str; 20] = [
    SYNTAX,
    SIZE,
    TEXT,
    NESTING,
    HTML_COMMENT,
    NOT_ALLOWED,
    "network",
    "storage",
    "dynamic-code",
    "markup",
    NAVIGATION,
    "automation",
    "credentials",
    GLOBAL_NOT_ALLOWED,
    MEMBER_NOT_ALLOWED,
    COMPUTED,
    BAD_ARGUMENT,
    BAD_WRITE,
    INSERT,
    REGEX,
];

const MAX_NAME_ECHO: usize = 40;
const MAX_INDEX: f64 = 1_000_000.0;

/// One thing a script does that the policy refuses. `line` counts from 1 and `column` from 0, in
/// the script's own text.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Finding {
    pub code: &'static str,
    pub message: String,
    pub line: u32,
    pub column: u32,
}

/// The exact text the page runs for a script rule, and the exact text the scanner parses.
pub fn wrap(code: &str) -> String {
    format!("{WRAPPER_PREFIX}{code}{WRAPPER_SUFFIX}")
}

/// Every finding of the full policy; empty means the script passes. Used for imported recipes
/// (to refuse) and for the assistant's own scripts (to report the powers they use).
pub fn scan(code: &str) -> Vec<Finding> {
    let owned = code.to_owned();
    on_big_stack(SCAN_STACK_BYTES, move || scan_text(&owned)).unwrap_or_else(|| vec![unavailable()])
}

/// Only the parse and the wrapper shape: is this text one function body that cannot leave its
/// wrapper? Used for recipes the policy does not restrict.
pub fn check_shape(code: &str) -> Option<Finding> {
    if code.len() > MAX_CODE_BYTES {
        return Some(too_big());
    }
    let owned = code.to_owned();
    on_big_stack(SCAN_STACK_BYTES, move || shape_of(&owned)).unwrap_or_else(|| Some(unavailable()))
}

fn on_big_stack<T: Send + 'static>(
    stack_bytes: usize,
    job: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    std::thread::Builder::new()
        .name("script-policy".into())
        .stack_size(stack_bytes)
        .spawn(job)
        .ok()?
        .join()
        .ok()
}

fn plain(code: &'static str, message: &str) -> Finding {
    Finding {
        code,
        message: message.into(),
        line: 1,
        column: 0,
    }
}

fn unavailable() -> Finding {
    plain(SYNTAX, "The script could not be checked.")
}

fn too_big() -> Finding {
    plain(
        SIZE,
        "The script is longer than 16384 bytes, the most a script rule may hold.",
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLimits {
    nodes: usize,
    bracket_depth: usize,
    findings: usize,
    style_value_chars: usize,
    text_literal_chars: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPolicy {
    limits: RawLimits,
    node_types: Vec<String>,
    unary_operators: Vec<String>,
    globals: Vec<String>,
    constructors: Vec<String>,
    reserved_bindings: Vec<String>,
    banned_bindings: Vec<String>,
    members: Vec<String>,
    location_reads: Vec<String>,
    write_members: Vec<String>,
    text_sinks: Vec<String>,
    dataset_write_prefix: String,
    restricted_calls: Vec<String>,
    timer_calls: Vec<String>,
    insertion_calls: HashMap<String, String>,
    create_tags: Vec<String>,
    events: Vec<String>,
    attributes: Vec<String>,
    attribute_prefixes: Vec<String>,
    style_properties: HashMap<String, String>,
    style_functions: Vec<String>,
    style_value_pattern: String,
    unsafe_text_pattern: String,
    categories: HashMap<String, Vec<String>>,
    sweep_names: Vec<String>,
    codes: Vec<String>,
}

fn set(names: Vec<String>) -> HashSet<String> {
    names.into_iter().collect()
}

struct Policy {
    node_limit: usize,
    bracket_depth: usize,
    max_findings: usize,
    style_value_chars: usize,
    text_literal_chars: usize,
    node_types: HashSet<String>,
    unary: HashSet<String>,
    globals: HashSet<String>,
    constructors: HashSet<String>,
    reserved: HashSet<String>,
    banned: HashSet<String>,
    members: HashSet<String>,
    location_reads: HashSet<String>,
    write_members: HashSet<String>,
    text_sinks: HashSet<String>,
    restricted: HashSet<String>,
    timers: HashSet<String>,
    create_tags: HashSet<String>,
    events: HashSet<String>,
    attributes: HashSet<String>,
    style_functions: HashSet<String>,
    style_names: HashSet<String>,
    style_camel: HashSet<String>,
    dataset_prefix: String,
    attribute_prefixes: Vec<String>,
    insertion: HashMap<String, bool>,
    categories: HashMap<String, &'static str>,
    style_value: Regex,
    unsafe_text: Regex,
    nested_quantifier: Regex,
    sweep: HashSet<String>,
}

impl Policy {
    fn load() -> Result<Self, String> {
        let raw: RawPolicy = serde_json::from_str(POLICY_JSON).map_err(|e| e.to_string())?;
        if raw.codes != CODE_NAMES {
            return Err("policy.json lists finding codes this scanner does not know".into());
        }
        let categories = category_table(&raw.categories)?;
        let insertion = raw
            .insertion_calls
            .into_iter()
            .map(|(name, which)| (name, which == "all"))
            .collect();
        Ok(Self {
            node_limit: raw.limits.nodes,
            bracket_depth: raw.limits.bracket_depth,
            max_findings: raw.limits.findings,
            style_value_chars: raw.limits.style_value_chars,
            text_literal_chars: raw.limits.text_literal_chars,
            node_types: set(raw.node_types),
            unary: set(raw.unary_operators),
            globals: set(raw.globals),
            constructors: set(raw.constructors),
            reserved: set(raw.reserved_bindings),
            banned: set(raw.banned_bindings),
            members: set(raw.members),
            location_reads: set(raw.location_reads),
            write_members: set(raw.write_members),
            text_sinks: set(raw.text_sinks),
            restricted: set(raw.restricted_calls),
            timers: set(raw.timer_calls),
            create_tags: set(raw.create_tags),
            events: set(raw.events),
            attributes: set(raw.attributes),
            style_functions: set(raw.style_functions),
            style_camel: raw.style_properties.values().cloned().collect(),
            style_names: raw.style_properties.into_keys().collect(),
            dataset_prefix: raw.dataset_write_prefix,
            attribute_prefixes: raw.attribute_prefixes,
            insertion,
            categories,
            style_value: Regex::new(&raw.style_value_pattern).map_err(|e| e.to_string())?,
            unsafe_text: Regex::new(&raw.unsafe_text_pattern.replace("\\p{Cs}", ""))
                .map_err(|e| e.to_string())?,
            sweep: set(raw.sweep_names),
            nested_quantifier: Regex::new(r"[+*}]\)[+*{]").map_err(|e| e.to_string())?,
        })
    }

    fn category(&self, name: &str) -> Option<&'static str> {
        self.categories.get(name).copied()
    }
}

fn category_table(
    raw: &HashMap<String, Vec<String>>,
) -> Result<HashMap<String, &'static str>, String> {
    let mut table = HashMap::new();
    for code in CODE_NAMES {
        for name in raw.get(code).into_iter().flatten() {
            table.entry(name.clone()).or_insert(code);
        }
    }
    let known: usize = raw.values().map(Vec::len).sum();
    let named = raw.keys().all(|key| CODE_NAMES.contains(&key.as_str()));
    if named && known > 0 {
        Ok(table)
    } else {
        Err("policy.json has a category this scanner does not know".into())
    }
}

static POLICY: LazyLock<Result<Policy, String>> = LazyLock::new(Policy::load);

struct LineIndex<'a> {
    text: &'a str,
    starts: Vec<usize>,
    shift: u32,
}

impl<'a> LineIndex<'a> {
    fn new(text: &'a str, shift: u32) -> Self {
        let bytes = text.as_bytes();
        let mut starts = vec![0];
        for (i, byte) in bytes.iter().enumerate() {
            let lone_cr = *byte == b'\r' && bytes.get(i + 1) != Some(&b'\n');
            if *byte == b'\n' || lone_cr {
                starts.push(i + 1);
            }
        }
        Self {
            text,
            starts,
            shift,
        }
    }

    /// 1-based line and 0-based UTF-16 column of a byte offset, in the script's own text.
    fn position(&self, offset: usize) -> (u32, u32) {
        let offset = offset.min(self.text.len());
        let row = self.starts.partition_point(|start| *start <= offset) - 1;
        if row < self.shift as usize {
            return (1, 0);
        }
        let from = self.starts[row];
        let column = self
            .text
            .get(from..offset)
            .map_or(offset - from, |s| s.encode_utf16().count());
        let line = u32::try_from(row + 1 - self.shift as usize).unwrap_or(u32::MAX);
        (line, u32::try_from(column).unwrap_or(u32::MAX))
    }

    fn finding(&self, code: &'static str, offset: usize, what: &str) -> Finding {
        let (line, column) = self.position(offset);
        Finding {
            code,
            message: format!("{what} (line {line})"),
            line,
            column,
        }
    }
}

fn step_zero(code: &str, policy: &Policy) -> Option<Finding> {
    if code.len() > MAX_CODE_BYTES {
        return Some(too_big());
    }
    let lines = LineIndex::new(code, 0);
    let unsafe_char = policy
        .unsafe_text
        .find_iter(code)
        .find(|m| !matches!(m.as_str(), "\t" | "\n" | "\r"));
    if let Some(m) = unsafe_char {
        let what = "The script has a control, invisible or direction-changing character";
        return Some(lines.finding(TEXT, m.start(), what));
    }
    let comment = ["<!--", "-->"].iter().filter_map(|m| code.find(m)).min();
    if let Some(at) = comment {
        let what = "The script contains <!-- or -->, which browsers read as a comment";
        return Some(lines.finding(HTML_COMMENT, at, what));
    }
    too_deep(code, policy).map(|at| lines.finding(NESTING, at, "Brackets are nested too deeply"))
}

fn too_deep(code: &str, policy: &Policy) -> Option<usize> {
    let mut depth = 0usize;
    for (at, ch) in code.char_indices() {
        match ch {
            '(' | '[' | '{' => {
                depth += 1;
                if depth > policy.bracket_depth {
                    return Some(at);
                }
            }
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    None
}

fn parse_wrapped(wrapped: &str, lines: &LineIndex) -> Result<Value, Finding> {
    let allocator = Allocator::default();
    let options = ParseOptions {
        preserve_parens: false,
        parse_regular_expression: true,
        ..ParseOptions::default()
    };
    let ret = Parser::new(&allocator, wrapped, SourceType::script())
        .with_options(options)
        .parse();
    let mut diagnostics = ret.diagnostics.to_vec();
    if ret.fatal_error || diagnostics.is_empty() {
        let semantic = SemanticBuilder::new()
            .with_check_syntax_error(true)
            .build(&ret.program);
        diagnostics.extend(semantic.diagnostics.iter().cloned());
    }
    if ret.fatal_error || !diagnostics.is_empty() {
        let first = diagnostics.first();
        let at = first
            .and_then(|d| d.labels.first())
            .map_or(0, |label| label.offset() as usize);
        let message = first.map_or_else(String::new, |d| clip(&d.message, 100));
        return Err(lines.finding(SYNTAX, at, &format!("Syntax error: {message}")));
    }
    let json = ret.program.to_estree_json(false, false);
    let program = read_json(&json).ok_or_else(unavailable)?;
    if wrapper_holds(&program, wrapped.len()) {
        Ok(program)
    } else {
        let what = "The script is not a plain function body: it closes the wrapper early";
        Err(lines.finding(SYNTAX, 0, what))
    }
}

fn read_json(json: &str) -> Option<Value> {
    let mut reader = serde_json::Deserializer::from_str(json);
    reader.disable_recursion_limit();
    let value = Value::deserialize(&mut reader).ok()?;
    reader.end().ok()?;
    Some(value)
}

fn wrapper_holds(program: &Value, wrapped_len: usize) -> bool {
    let [statement] = items(program, "body") else {
        return false;
    };
    let function = field(statement, "expression");
    let body = field(function, "body");
    let first_is_directive = items(body, "body")
        .first()
        .is_some_and(|first| text(first, "directive") == "use strict");
    kind(statement) == "ExpressionStatement"
        && kind(function) == "FunctionExpression"
        && field(function, "id").is_null()
        && items(function, "params").is_empty()
        && !flag(function, "async")
        && !flag(function, "generator")
        && first_is_directive
        && offset(function) == 1
        && field(function, "end").as_u64() == u64::try_from(wrapped_len.saturating_sub(1)).ok()
}

fn shape_of(code: &str) -> Option<Finding> {
    let wrapped = wrap(code);
    let lines = LineIndex::new(&wrapped, 1);
    parse_wrapped(&wrapped, &lines).err()
}

fn scan_text(code: &str) -> Vec<Finding> {
    let Ok(policy) = POLICY.as_ref() else {
        return vec![unavailable()];
    };
    if let Some(finding) = step_zero(code, policy) {
        return vec![finding];
    }
    let wrapped = wrap(code);
    let lines = LineIndex::new(&wrapped, 1);
    let program = match parse_wrapped(&wrapped, &lines) {
        Ok(program) => program,
        Err(finding) => return vec![finding],
    };
    let wrapper = field(field(&items(&program, "body")[0], "expression"), "body");
    let mut scanner = Scanner::new(policy, lines);
    scanner.run(items(wrapper, "body").get(1..).unwrap_or(&[]));
    scanner.finish()
}

static NULL: Value = Value::Null;

fn field<'a>(node: &'a Value, key: &str) -> &'a Value {
    node.get(key).unwrap_or(&NULL)
}

fn kind(node: &Value) -> &str {
    text(node, "type")
}

fn text<'a>(node: &'a Value, key: &str) -> &'a str {
    field(node, key).as_str().unwrap_or("")
}

fn items<'a>(node: &'a Value, key: &str) -> &'a [Value] {
    field(node, key).as_array().map_or(&[], Vec::as_slice)
}

fn flag(node: &Value, key: &str) -> bool {
    field(node, key).as_bool().unwrap_or(false)
}

fn offset(node: &Value) -> usize {
    field(node, "start")
        .as_u64()
        .and_then(|v| usize::try_from(v).ok())
        .unwrap_or(0)
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}…")
}

fn string_literal(node: &Value) -> Option<&str> {
    if kind(node) == "Literal" {
        field(node, "value").as_str()
    } else {
        None
    }
}

fn is_index(node: &Value) -> bool {
    kind(node) == "Literal"
        && field(node, "value")
            .as_f64()
            .is_some_and(|v| v.fract() == 0.0 && (0.0..=MAX_INDEX).contains(&v))
}

fn identifier_name(node: &Value) -> Option<&str> {
    (kind(node) == "Identifier").then(|| text(node, "name"))
}

fn valid_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    let head = chars.next();
    head.is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

fn describe(code: &str, name: &str) -> String {
    let n = clip(name, MAX_NAME_ECHO);
    match code {
        "network" => format!("`{n}` could send data over the network"),
        "storage" => format!("`{n}` uses cookies or page storage"),
        "dynamic-code" => format!("`{n}` can run code built from text"),
        "markup" => format!("`{n}` builds page markup or styles from text"),
        NAVIGATION => format!("`{n}` can navigate the page"),
        "automation" => format!("`{n}` acts on the page for the user"),
        "credentials" => format!("`{n}` can read private data"),
        GLOBAL_NOT_ALLOWED => format!("`{n}` is not an allowed global"),
        MEMBER_NOT_ALLOWED => format!("`{n}` is not an allowed property"),
        BAD_WRITE => format!("`{n}` cannot be assigned to"),
        _ => format!("`{n}` is not allowed here"),
    }
}

fn not_allowed_phrase(node_type: &str) -> String {
    let phrase = match node_type {
        "FunctionDeclaration" => "function declarations",
        "ClassDeclaration" | "ClassExpression" => "classes",
        "WhileStatement" | "DoWhileStatement" => "while loops",
        "LabeledStatement" => "labels",
        "DebuggerStatement" => "debugger",
        "ImportExpression" | "ImportDeclaration" => "imports",
        "TaggedTemplateExpression" => "tagged templates",
        "AwaitExpression" | "YieldExpression" => "await and yield",
        "NewExpression" => "new",
        _ => return format!("This syntax ({node_type}) is not allowed"),
    };
    format!("{} are not allowed", capitalized(phrase))
}

fn capitalized(s: &str) -> String {
    let mut chars = s.chars();
    chars
        .next()
        .map_or_else(String::new, |c| c.to_uppercase().chain(chars).collect())
}

#[derive(Clone, Copy, Default)]
struct Binding {
    created: bool,
    func: bool,
}

#[derive(Clone, Copy)]
enum Mode<'a> {
    Declare,
    Assign { op: &'a str, rhs: Option<&'a Value> },
}

impl Mode<'_> {
    fn nested(self) -> Mode<'static> {
        match self {
            Mode::Declare => Mode::Declare,
            Mode::Assign { .. } => Mode::Assign { op: "=", rhs: None },
        }
    }
}

enum Callee<'a> {
    Bare(&'a str),
    Method { name: &'a str, receiver: &'a Value },
    Other,
}

struct Scanner<'p> {
    policy: &'p Policy,
    lines: LineIndex<'p>,
    found: Vec<Finding>,
    nodes: usize,
    halted: bool,
    scopes: Vec<HashMap<String, Binding>>,
}

impl<'p> Scanner<'p> {
    fn new(policy: &'p Policy, lines: LineIndex<'p>) -> Self {
        Self {
            policy,
            lines,
            found: Vec::new(),
            nodes: 0,
            halted: false,
            scopes: Vec::new(),
        }
    }

    fn finish(self) -> Vec<Finding> {
        let mut seen = HashSet::new();
        let mut kept: Vec<Finding> = self
            .found
            .into_iter()
            .filter(|f| seen.insert((f.code, f.line, f.column)))
            .collect();
        kept.sort_by_key(|f| (f.line, f.column));
        kept.truncate(self.policy.max_findings);
        kept
    }

    fn run(&mut self, body: &[Value]) {
        self.scopes.push(HashMap::new());
        self.predeclare(body);
        for statement in body {
            self.stmt(statement);
        }
    }

    fn report(&mut self, code: &'static str, at: &Value, what: &str) {
        let finding = self.lines.finding(code, offset(at), what);
        self.found.push(finding);
    }

    fn refuse(&mut self, at: &Value, name: &str, fallback: &'static str) {
        let code = self.policy.category(name).unwrap_or(fallback);
        self.report(code, at, &describe(code, name));
    }

    fn deny(&mut self, node: &Value, what: &str) {
        self.report(NOT_ALLOWED, node, what);
        self.sweep(node);
    }

    fn sweep(&mut self, node: &Value) {
        match node {
            Value::Array(list) => list.iter().for_each(|item| self.sweep(item)),
            Value::Object(map) => {
                if self.halted {
                    return;
                }
                if map.get("type").is_some_and(Value::is_string) {
                    self.nodes += 1;
                    if self.nodes > self.policy.node_limit {
                        self.halted = true;
                        self.report(SIZE, node, "The script has too many parts to check");
                        return;
                    }
                    self.sweep_name(node);
                }
                map.values().for_each(|child| self.sweep(child));
            }
            _ => {}
        }
    }

    fn sweep_name(&mut self, node: &Value) {
        let name = match kind(node) {
            "Identifier" => text(node, "name"),
            "Literal" => string_literal(node).unwrap_or(""),
            _ => "",
        };
        if self.policy.sweep.contains(name) {
            self.refuse(node, name, MEMBER_NOT_ALLOWED);
        }
    }

    fn enter<'a>(&mut self, node: &'a Value) -> Option<&'a str> {
        if self.halted {
            return None;
        }
        self.nodes += 1;
        if self.nodes > self.policy.node_limit {
            self.halted = true;
            self.report(SIZE, node, "The script has too many parts to check");
            return None;
        }
        let node_type = kind(node);
        if node_type == "WithStatement" {
            self.report(SYNTAX, node, "Strict mode does not allow with statements");
            return None;
        }
        if !self.policy.node_types.contains(node_type) {
            self.deny(node, &not_allowed_phrase(node_type));
            return None;
        }
        if node_type == "Identifier" && !valid_identifier(text(node, "name")) {
            let what = "A name uses characters other than plain letters, digits, _ and $";
            self.report(TEXT, node, what);
        }
        Some(node_type)
    }

    fn lookup(&self, name: &str) -> Option<Binding> {
        self.scopes
            .iter()
            .rev()
            .find_map(|scope| scope.get(name).copied())
    }

    fn declare(&mut self, name: &str) {
        if let Some(scope) = self.scopes.last_mut() {
            scope.entry(name.to_owned()).or_default();
        }
    }

    fn predeclare(&mut self, statements: &[Value]) {
        let mut names = Vec::new();
        for statement in statements
            .iter()
            .filter(|s| kind(s) == "VariableDeclaration")
        {
            for declarator in items(statement, "declarations") {
                collect_names(field(declarator, "id"), &mut names);
            }
        }
        for name in names {
            self.declare(&name);
        }
    }

    fn scoped(&mut self, inner: impl FnOnce(&mut Self)) {
        self.scopes.push(HashMap::new());
        inner(self);
        self.scopes.pop();
    }

    fn stmt(&mut self, node: &Value) {
        let Some(node_type) = self.enter(node) else {
            return;
        };
        match node_type {
            "ExpressionStatement" => self.expr(field(node, "expression")),
            "BlockStatement" => self.block(items(node, "body")),
            "VariableDeclaration" => self.variable_declaration(node),
            "IfStatement" => self.if_statement(node),
            "ForStatement" => self.for_statement(node),
            "ForInStatement" | "ForOfStatement" => self.for_each_statement(node),
            "ReturnStatement" | "ThrowStatement" => self.optional_expr(field(node, "argument")),
            "BreakStatement" | "ContinueStatement" if !field(node, "label").is_null() => {
                self.report(NOT_ALLOWED, node, "Labels are not allowed");
            }
            "TryStatement" => self.try_statement(node),
            "SwitchStatement" => self.switch_statement(node),
            _ => {}
        }
    }

    fn block(&mut self, statements: &[Value]) {
        self.scoped(|this| {
            this.predeclare(statements);
            for statement in statements {
                this.stmt(statement);
            }
        });
    }

    fn optional_expr(&mut self, node: &Value) {
        if !node.is_null() {
            self.expr(node);
        }
    }

    fn optional_stmt(&mut self, node: &Value) {
        if !node.is_null() {
            self.stmt(node);
        }
    }

    fn if_statement(&mut self, node: &Value) {
        self.expr(field(node, "test"));
        self.stmt(field(node, "consequent"));
        self.optional_stmt(field(node, "alternate"));
    }

    fn head(&mut self, init: &Value) {
        if init.is_null() {
            return;
        }
        if kind(init) == "VariableDeclaration" {
            self.predeclare(std::slice::from_ref(init));
            if self.enter(init).is_some() {
                self.variable_declaration(init);
            }
        } else {
            self.expr(init);
        }
    }

    fn for_statement(&mut self, node: &Value) {
        if field(node, "test").is_null() {
            self.report(NOT_ALLOWED, node, "A for loop needs a test condition");
        }
        self.scoped(|this| {
            this.head(field(node, "init"));
            this.optional_expr(field(node, "test"));
            this.optional_expr(field(node, "update"));
            this.stmt(field(node, "body"));
        });
    }

    fn for_each_statement(&mut self, node: &Value) {
        if flag(node, "await") {
            self.deny(node, "for await is not allowed");
            return;
        }
        self.scoped(|this| {
            let left = field(node, "left");
            if kind(left) == "VariableDeclaration" {
                this.head(left);
            } else {
                this.pattern(left, Mode::Assign { op: "=", rhs: None });
            }
            this.expr(field(node, "right"));
            this.stmt(field(node, "body"));
        });
    }

    fn try_statement(&mut self, node: &Value) {
        self.stmt(field(node, "block"));
        let handler = field(node, "handler");
        if !handler.is_null() && self.enter(handler).is_some() {
            self.scoped(|this| this.catch_clause(handler));
        }
        self.optional_stmt(field(node, "finalizer"));
    }

    fn catch_clause(&mut self, handler: &Value) {
        let param = field(handler, "param");
        if !param.is_null() {
            if kind(param) != "Identifier" {
                self.report(NOT_ALLOWED, param, "A catch parameter must be a plain name");
            }
            let mut names = Vec::new();
            collect_names(param, &mut names);
            for name in names {
                self.declare(&name);
            }
            self.pattern(param, Mode::Declare);
        }
        self.stmt(field(handler, "body"));
    }

    fn switch_statement(&mut self, node: &Value) {
        self.expr(field(node, "discriminant"));
        self.scoped(|this| {
            let cases = items(node, "cases");
            for case in cases {
                this.predeclare(items(case, "consequent"));
            }
            for case in cases {
                if this.enter(case).is_none() {
                    continue;
                }
                this.optional_expr(field(case, "test"));
                for statement in items(case, "consequent") {
                    this.stmt(statement);
                }
            }
        });
    }

    fn variable_declaration(&mut self, node: &Value) {
        let declaration_kind = text(node, "kind");
        if declaration_kind != "const" && declaration_kind != "let" {
            self.deny(node, "var is not allowed, use const or let");
            return;
        }
        for declarator in items(node, "declarations") {
            if self.enter(declarator).is_none() {
                continue;
            }
            let id = field(declarator, "id");
            let init = field(declarator, "init");
            self.pattern(id, Mode::Declare);
            self.optional_expr(init);
            if declaration_kind == "const" {
                self.flag_binding(id, init);
            }
        }
    }

    fn flag_binding(&mut self, id: &Value, init: &Value) {
        let Some(name) = identifier_name(id) else {
            return;
        };
        let binding = Binding {
            created: self.is_created_call(init, true),
            func: matches!(kind(init), "ArrowFunctionExpression" | "FunctionExpression"),
        };
        if let Some(scope) = self.scopes.last_mut() {
            scope.insert(name.to_owned(), binding);
        }
    }

    fn is_created_call(&self, node: &Value, check_tag: bool) -> bool {
        let callee = field(node, "callee");
        let args = items(node, "arguments");
        let document = field(callee, "object");
        let on_global_document = kind(node) == "CallExpression"
            && !flag(node, "optional")
            && kind(callee) == "MemberExpression"
            && !flag(callee, "computed")
            && !flag(callee, "optional")
            && identifier_name(document) == Some("document")
            && self.lookup("document").is_none()
            && identifier_name(field(callee, "property")) == Some("createElement");
        let tag_ok = !check_tag
            || (args.len() == 1
                && string_literal(&args[0])
                    .is_some_and(|tag| self.policy.create_tags.contains(tag)));
        on_global_document && tag_ok
    }

    fn is_created_element(&self, node: &Value) -> bool {
        identifier_name(node)
            .and_then(|name| self.lookup(name))
            .is_some_and(|binding| binding.created)
    }

    fn pattern(&mut self, node: &Value, mode: Mode) {
        if node.is_null() {
            return;
        }
        let Some(node_type) = self.enter(node) else {
            return;
        };
        match (node_type, mode) {
            ("Identifier", Mode::Declare) => self.check_declared(node),
            ("Identifier", Mode::Assign { .. }) => self.write_identifier(node),
            ("MemberExpression", Mode::Assign { op, rhs }) => self.write_member(node, op, rhs),
            ("AssignmentPattern", _) => {
                self.pattern(field(node, "left"), mode.nested());
                self.expr(field(node, "right"));
            }
            ("ArrayPattern", _) => {
                for element in items(node, "elements") {
                    self.pattern(element, mode.nested());
                }
            }
            ("ObjectPattern", _) => {
                for property in items(node, "properties") {
                    self.pattern_property(property, mode.nested());
                }
            }
            ("RestElement", _) => self.pattern(field(node, "argument"), mode.nested()),
            _ => {}
        }
    }

    fn pattern_property(&mut self, property: &Value, mode: Mode) {
        if kind(property) == "RestElement" {
            self.pattern(property, mode);
            return;
        }
        if self.enter(property).is_none() {
            return;
        }
        let key = field(property, "key");
        if flag(property, "computed") {
            self.expr(key);
            self.report(COMPUTED, key, "Computed property names are not allowed");
        } else {
            self.pattern_key(key);
        }
        self.pattern(field(property, "value"), mode);
    }

    fn pattern_key(&mut self, key: &Value) {
        if self.enter(key).is_none() {
            return;
        }
        let name = identifier_name(key).or_else(|| string_literal(key));
        match name {
            Some("location") => self.report(NAVIGATION, key, "location cannot be taken apart"),
            Some(name) => self.read_name(key, name, false),
            None if is_index(key) => {}
            None => self.report(COMPUTED, key, "This property key is not allowed"),
        }
    }

    fn check_declared(&mut self, node: &Value) {
        let name = text(node, "name");
        if self.policy.banned.contains(name) || self.policy.reserved.contains(name) {
            match self.policy.category(name) {
                Some(code) => self.report(code, node, &describe(code, name)),
                None => {
                    let what = format!("`{}` cannot be declared", clip(name, MAX_NAME_ECHO));
                    self.report(NOT_ALLOWED, node, &what);
                }
            }
        }
    }

    fn write_identifier(&mut self, node: &Value) {
        let name = text(node, "name");
        if self.lookup(name).is_some() {
            return;
        }
        if self.policy.globals.contains(name) {
            self.refuse(node, name, BAD_WRITE);
        } else {
            self.refuse(node, name, GLOBAL_NOT_ALLOWED);
        }
    }

    fn expr(&mut self, node: &Value) {
        self.expr_loc(node, false);
    }

    fn expr_loc(&mut self, node: &Value, location_ok: bool) {
        let Some(node_type) = self.enter(node) else {
            return;
        };
        match node_type {
            "Identifier" => self.reference(node, false),
            "Literal" => self.literal(node),
            "TemplateLiteral" => self.template(node),
            "ArrayExpression" => {
                for element in items(node, "elements") {
                    self.optional_expr(element);
                }
            }
            "ObjectExpression" => {
                for property in items(node, "properties") {
                    self.object_member(property);
                }
            }
            "SpreadElement" => self.expr(field(node, "argument")),
            "ArrowFunctionExpression" | "FunctionExpression" => self.function(node),
            "UnaryExpression" => self.unary(node),
            "UpdateExpression" => {
                let mode = Mode::Assign {
                    op: text(node, "operator"),
                    rhs: None,
                };
                self.pattern(field(node, "argument"), mode);
            }
            "BinaryExpression" | "LogicalExpression" => {
                self.expr(field(node, "left"));
                self.expr(field(node, "right"));
            }
            "AssignmentExpression" => {
                let right = field(node, "right");
                let mode = Mode::Assign {
                    op: text(node, "operator"),
                    rhs: Some(right),
                };
                self.pattern(field(node, "left"), mode);
                self.expr(right);
            }
            "ConditionalExpression" => {
                self.expr(field(node, "test"));
                self.expr(field(node, "consequent"));
                self.expr(field(node, "alternate"));
            }
            "CallExpression" => self.call(node),
            "NewExpression" => self.new_expression(node),
            "MemberExpression" => self.member(node, false, location_ok),
            "ChainExpression" => self.expr_loc(field(node, "expression"), location_ok),
            "SequenceExpression" => {
                for expression in items(node, "expressions") {
                    self.expr(expression);
                }
            }
            _ => {}
        }
    }

    fn reference(&mut self, node: &Value, callee: bool) {
        let name = text(node, "name");
        if self.lookup(name).is_some() {
            return;
        }
        if !self.policy.globals.contains(name) {
            self.refuse(node, name, GLOBAL_NOT_ALLOWED);
        } else if !callee && self.policy.restricted.contains(name) {
            let what = format!(
                "`{}` may only be called, not stored or passed on",
                clip(name, MAX_NAME_ECHO)
            );
            self.report(BAD_ARGUMENT, node, &what);
        }
    }

    fn literal(&mut self, node: &Value) {
        if !field(node, "bigint").is_null() {
            self.report(NOT_ALLOWED, node, "BigInt literals are not allowed");
        }
        let regex = field(node, "regex");
        if regex.is_null() {
            return;
        }
        let pattern = text(regex, "pattern");
        let flags = text(regex, "flags");
        if self.policy.nested_quantifier.is_match(pattern) {
            let what = "This regular expression repeats a repeated group and can hang the page";
            self.report(REGEX, node, what);
        } else if !flags.chars().all(|c| "gimsuy".contains(c)) || pattern.contains("(?<") {
            let what = "This regular expression uses syntax older browsers cannot read";
            self.report(REGEX, node, what);
        }
    }

    fn template(&mut self, node: &Value) {
        for quasi in items(node, "quasis") {
            self.enter(quasi);
        }
        for expression in items(node, "expressions") {
            self.expr(expression);
        }
    }

    fn unary(&mut self, node: &Value) {
        let operator = text(node, "operator");
        if self.policy.unary.contains(operator) {
            self.expr(field(node, "argument"));
        } else {
            let what = format!(
                "The `{}` operator is not allowed",
                clip(operator, MAX_NAME_ECHO)
            );
            self.deny(node, &what);
        }
    }

    fn object_member(&mut self, member: &Value) {
        let Some(member_type) = self.enter(member) else {
            return;
        };
        if member_type == "SpreadElement" {
            self.expr(field(member, "argument"));
            return;
        }
        if text(member, "kind") != "init" {
            self.deny(member, "Getters and setters are not allowed");
            return;
        }
        let key = field(member, "key");
        if flag(member, "computed") {
            self.expr(key);
            self.report(COMPUTED, key, "Computed property names are not allowed");
        } else {
            self.object_key(key);
        }
        self.expr(field(member, "value"));
    }

    fn object_key(&mut self, key: &Value) {
        if self.enter(key).is_none() {
            return;
        }
        let name = identifier_name(key).or_else(|| string_literal(key));
        if let Some(name) = name.filter(|n| self.policy.banned.contains(*n)) {
            self.refuse(key, name, NOT_ALLOWED);
        }
    }

    fn function(&mut self, node: &Value) {
        if flag(node, "async") || flag(node, "generator") {
            self.deny(node, "async and generator functions are not allowed");
            return;
        }
        self.scoped(|this| this.function_body(node));
    }

    fn function_body(&mut self, node: &Value) {
        let id = field(node, "id");
        if !id.is_null() && self.enter(id).is_some() {
            self.check_declared(id);
            self.declare(text(id, "name"));
        }
        let params = items(node, "params");
        let mut names = Vec::new();
        for param in params {
            collect_names(param, &mut names);
        }
        for name in names {
            self.declare(&name);
        }
        for param in params {
            self.pattern(param, Mode::Declare);
        }
        let body = field(node, "body");
        if kind(body) != "BlockStatement" {
            self.expr(body);
        } else if self.enter(body).is_some() {
            let statements = items(body, "body");
            self.predeclare(statements);
            for statement in statements {
                self.stmt(statement);
            }
        }
    }

    fn call(&mut self, node: &Value) {
        let args = items(node, "arguments");
        let callee = self.callee(field(node, "callee"));
        for arg in args {
            self.expr(arg);
        }
        match callee {
            Callee::Bare(name)
                if self.policy.timers.contains(name) && self.lookup(name).is_none() =>
            {
                self.check_timer(node, args);
            }
            Callee::Method { name, receiver } => self.method_rules(node, name, receiver, args),
            _ => {}
        }
    }

    fn callee<'a>(&mut self, callee: &'a Value) -> Callee<'a> {
        match kind(callee) {
            "Identifier" => {
                if self.enter(callee).is_none() {
                    return Callee::Other;
                }
                self.reference(callee, true);
                Callee::Bare(text(callee, "name"))
            }
            "MemberExpression" => {
                if self.enter(callee).is_none() {
                    return Callee::Other;
                }
                self.member_body(callee, true, false);
                match identifier_name(field(callee, "property")) {
                    Some(name) if !flag(callee, "computed") => Callee::Method {
                        name,
                        receiver: field(callee, "object"),
                    },
                    _ => Callee::Other,
                }
            }
            _ => {
                self.expr(callee);
                Callee::Other
            }
        }
    }

    fn bad_argument(&mut self, at: &Value, name: &str, rule: &str) {
        let what = format!("`{}` {rule}", clip(name, MAX_NAME_ECHO));
        self.report(BAD_ARGUMENT, at, &what);
    }

    fn method_rules(&mut self, call: &Value, name: &str, receiver: &Value, args: &[Value]) {
        let tags = &self.policy;
        let first_literal = args.first().and_then(string_literal);
        match name {
            "createElement"
                if !(args.len() == 1
                    && first_literal.is_some_and(|t| tags.create_tags.contains(t))) =>
            {
                self.bad_argument(call, name, "takes one literal tag from the allowed list");
            }
            "setAttribute"
                if !(args.len() == 2
                    && first_literal.is_some_and(|a| self.attribute_allowed(a))) =>
            {
                self.bad_argument(
                    call,
                    name,
                    "takes two arguments and an allowed literal attribute name",
                );
            }
            "addEventListener" | "removeEventListener"
                if !(args.len() >= 2
                    && first_literal.is_some_and(|e| self.policy.events.contains(e))) =>
            {
                self.bad_argument(
                    call,
                    name,
                    "needs an allowed literal event name and a handler",
                );
            }
            "setProperty" => self.check_set_property(call, args),
            "removeProperty"
                if !(args.len() == 1
                    && first_literal.is_some_and(|p| self.policy.style_names.contains(p))) =>
            {
                self.bad_argument(call, name, "takes one allowed literal style property");
            }
            _ => {}
        }
        if self.policy.timers.contains(name) {
            self.check_timer(call, args);
        }
        if let Some(all) = self.policy.insertion.get(name).copied() {
            self.check_insertion(call, receiver, args, all);
        }
    }

    fn attribute_allowed(&self, name: &str) -> bool {
        self.policy.attributes.contains(name)
            || self
                .policy
                .attribute_prefixes
                .iter()
                .any(|prefix| name.starts_with(prefix.as_str()))
    }

    fn check_set_property(&mut self, call: &Value, args: &[Value]) {
        let name_ok = args
            .first()
            .and_then(string_literal)
            .is_some_and(|n| self.policy.style_names.contains(n));
        let important_ok = args
            .get(2)
            .is_none_or(|a| string_literal(a) == Some("important"));
        let shape_ok = (2..=3).contains(&args.len());
        if !(shape_ok
            && name_ok
            && important_ok
            && args.get(1).is_some_and(|v| self.safe_style_value(v)))
        {
            self.bad_argument(
                call,
                "setProperty",
                "takes an allowed literal style property and a safe literal value",
            );
        }
    }

    fn check_timer(&mut self, call: &Value, args: &[Value]) {
        let callback_ok = args.first().is_some_and(|first| {
            matches!(
                kind(first),
                "ArrowFunctionExpression" | "FunctionExpression"
            ) || identifier_name(first)
                .and_then(|name| self.lookup(name))
                .is_some_and(|binding| binding.func)
        });
        if !callback_ok {
            let what = "A timer needs a function (written inline or a const function), not text";
            self.report(BAD_ARGUMENT, call, what);
        }
    }

    fn check_insertion(&mut self, call: &Value, receiver: &Value, args: &[Value], all: bool) {
        if self.is_created_element(receiver) {
            return;
        }
        let checked = if all {
            args
        } else {
            args.get(..1).unwrap_or(&[])
        };
        for arg in checked {
            if !(self.is_created_element(arg) || self.is_created_call(arg, false)) {
                let what = "Only elements the script created can be inserted into the page";
                self.report(INSERT, arg, what);
            }
        }
        let _ = call;
    }

    fn new_expression(&mut self, node: &Value) {
        let callee = field(node, "callee");
        if kind(callee) == "Identifier" {
            if self.enter(callee).is_some() {
                self.constructor(callee);
            }
        } else {
            self.expr(callee);
            self.report(BAD_ARGUMENT, callee, "new needs a plain constructor name");
        }
        for arg in items(node, "arguments") {
            self.expr(arg);
        }
    }

    fn constructor(&mut self, callee: &Value) {
        let name = text(callee, "name");
        if self.lookup(name).is_some() {
            return;
        }
        if !self.policy.globals.contains(name) {
            self.refuse(callee, name, GLOBAL_NOT_ALLOWED);
        } else if !self.policy.constructors.contains(name) {
            self.bad_argument(callee, name, "cannot be used with new");
        }
    }

    fn member(&mut self, node: &Value, callee: bool, location_ok: bool) {
        self.member_body(node, callee, location_ok);
    }

    fn member_body(&mut self, node: &Value, callee: bool, location_ok: bool) {
        let object = field(node, "object");
        let property = field(node, "property");
        let computed = flag(node, "computed");
        let name = if computed {
            None
        } else {
            identifier_name(property)
        };
        let reads_location =
            !callee && name.is_some_and(|n| self.policy.location_reads.contains(n));
        self.expr_loc(object, reads_location);
        if computed {
            self.index(property);
            return;
        }
        if self.enter(property).is_none() {
            return;
        }
        let Some(name) = name else {
            return;
        };
        if name == "location" && !location_ok {
            let what = "location may only be read as .location.pathname and similar";
            self.report(NAVIGATION, node, what);
        }
        self.read_property(property, object, name, callee);
    }

    fn index(&mut self, property: &Value) {
        self.expr(property);
        if !is_index(property) {
            self.report(
                COMPUTED,
                property,
                "Only a plain number can be used inside [ ]",
            );
        }
    }

    fn read_property(&mut self, at: &Value, object: &Value, name: &str, callee: bool) {
        if is_accessor(object, "dataset") {
            if self.policy.banned.contains(name) {
                self.refuse(at, name, NOT_ALLOWED);
            }
            return;
        }
        if is_accessor(object, "style") {
            self.read_style(at, name, callee);
            return;
        }
        self.read_name(at, name, callee);
    }

    fn read_style(&mut self, at: &Value, name: &str, callee: bool) {
        if self.policy.style_camel.contains(name) || name == "getPropertyValue" {
            return;
        }
        if matches!(name, "setProperty" | "removeProperty") {
            if !callee {
                self.bad_argument(at, name, "may only be called, not stored or passed on");
            }
            return;
        }
        self.refuse(at, name, MEMBER_NOT_ALLOWED);
    }

    fn read_name(&mut self, at: &Value, name: &str, callee: bool) {
        if !self.policy.members.contains(name) {
            self.refuse(at, name, MEMBER_NOT_ALLOWED);
        } else if !callee && self.policy.restricted.contains(name) {
            self.bad_argument(at, name, "may only be called, not stored or passed on");
        }
    }

    fn write_member(&mut self, node: &Value, op: &str, rhs: Option<&Value>) {
        let object = field(node, "object");
        let property = field(node, "property");
        self.expr_loc(object, false);
        if flag(node, "computed") {
            self.index(property);
            return;
        }
        if self.enter(property).is_none() {
            return;
        }
        let Some(name) = identifier_name(property) else {
            return;
        };
        if is_accessor(object, "dataset") {
            self.write_dataset(property, name);
        } else if is_accessor(object, "style") {
            self.write_style(property, name, op, rhs);
        } else if !self.policy.write_members.contains(name) {
            self.refuse(property, name, BAD_WRITE);
        } else if self.policy.text_sinks.contains(name) && !self.is_created_element(object) {
            let literal_ok = op == "=" && rhs.is_some_and(|value| self.safe_text_literal(value));
            if !literal_ok {
                let what = format!(
                    "`{name}` on a page element can only be set to a short plain text literal"
                );
                self.report(BAD_WRITE, property, &what);
            }
        }
    }

    fn write_dataset(&mut self, at: &Value, name: &str) {
        let prefixed = name.starts_with(self.policy.dataset_prefix.as_str());
        if self.policy.banned.contains(name) || !prefixed {
            self.refuse(at, name, BAD_WRITE);
        }
    }

    fn write_style(&mut self, at: &Value, name: &str, op: &str, rhs: Option<&Value>) {
        if !self.policy.style_camel.contains(name) {
            self.refuse(at, name, BAD_WRITE);
        } else if !(op == "=" && rhs.is_some_and(|value| self.safe_style_value(value))) {
            let what = format!(
                "`style.{}` can only be set to a short plain literal",
                clip(name, MAX_NAME_ECHO)
            );
            self.report(BAD_WRITE, at, &what);
        }
    }

    fn safe_style_value(&self, node: &Value) -> bool {
        if kind(node) != "Literal" {
            return false;
        }
        match field(node, "value") {
            Value::Number(_) => true,
            Value::String(value) => self.style_string_ok(value),
            _ => false,
        }
    }

    fn style_string_ok(&self, value: &str) -> bool {
        value.encode_utf16().count() <= self.policy.style_value_chars
            && self.policy.style_value.is_match(value)
            && function_names(value).all(|name| {
                self.policy
                    .style_functions
                    .contains(&name.to_ascii_lowercase())
            })
    }

    fn safe_text_literal(&self, node: &Value) -> bool {
        match kind(node) {
            "Literal" => match field(node, "value") {
                Value::Number(_) => true,
                Value::String(value) => self.text_ok(value),
                _ => false,
            },
            "TemplateLiteral" => {
                let quasis = items(node, "quasis");
                items(node, "expressions").is_empty()
                    && quasis.len() == 1
                    && field(field(&quasis[0], "value"), "cooked")
                        .as_str()
                        .is_some_and(|value| self.text_ok(value))
            }
            _ => false,
        }
    }

    fn text_ok(&self, value: &str) -> bool {
        const FORBIDDEN: [&str; 5] = ["url(", "image-set(", "src(", "element(", "expression("];
        if value.encode_utf16().count() > self.policy.text_literal_chars
            || value.contains(['@', '\\', '{', '}', '<', '>'])
            || value.contains("://")
        {
            return false;
        }
        let squeezed: String = value
            .chars()
            .filter(|c| !c.is_whitespace())
            .flat_map(char::to_lowercase)
            .collect();
        !FORBIDDEN.iter().any(|word| squeezed.contains(word))
    }
}

fn is_accessor(object: &Value, name: &str) -> bool {
    let inner = if kind(object) == "ChainExpression" {
        field(object, "expression")
    } else {
        object
    };
    kind(inner) == "MemberExpression"
        && !flag(inner, "computed")
        && identifier_name(field(inner, "property")) == Some(name)
}

fn function_names(value: &str) -> impl Iterator<Item = &str> {
    let bytes = value.as_bytes();
    bytes
        .iter()
        .enumerate()
        .filter(|(_, b)| **b == b'(')
        .map(move |(at, _)| {
            let name_byte = |b: &u8| b.is_ascii_alphanumeric() || *b == b'-';
            let len = bytes[..at]
                .iter()
                .rev()
                .take_while(|b| name_byte(b))
                .count();
            &value[at - len..at]
        })
        .filter(|name| !name.is_empty())
}

fn collect_names(node: &Value, out: &mut Vec<String>) {
    match kind(node) {
        "Identifier" => out.push(text(node, "name").to_owned()),
        "AssignmentPattern" => collect_names(field(node, "left"), out),
        "ArrayPattern" => items(node, "elements")
            .iter()
            .for_each(|e| collect_names(e, out)),
        "ObjectPattern" => {
            for property in items(node, "properties") {
                let target = if kind(property) == "Property" {
                    field(property, "value")
                } else {
                    property
                };
                collect_names(target, out);
            }
        }
        "RestElement" => collect_names(field(node, "argument"), out),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &str = include_str!("../../../shared/script-policy/vectors.json");

    fn case_code(case: &Value) -> String {
        if let Some(code) = case["code"].as_str() {
            return code.to_owned();
        }
        let g = &case["generate"];
        let times = g["times"].as_u64().unwrap_or(0) as usize;
        match g["repeat"].as_str() {
            Some(unit) => unit.repeat(times),
            None => {
                let part = |key: &str| g[key].as_str().unwrap_or("").to_owned();
                format!(
                    "{}{}{}",
                    part("open").repeat(times),
                    part("inner"),
                    part("close").repeat(times)
                )
            }
        }
    }

    fn codes_of(findings: &[Finding]) -> Vec<String> {
        let mut codes: Vec<String> = findings.iter().map(|f| f.code.to_owned()).collect();
        codes.sort();
        codes.dedup();
        codes
    }

    #[test]
    fn every_conformance_vector_agrees() {
        let file: Value = serde_json::from_str(VECTORS).unwrap();
        let cases = file["cases"].as_array().unwrap();
        let mut failures = Vec::new();
        for case in cases {
            let name = case["name"].as_str().unwrap_or("?");
            let found = scan(&case_code(case));
            let expected: Vec<String> = if case["ok"].as_bool() == Some(true) {
                Vec::new()
            } else {
                let mut e: Vec<String> = case["codes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| c.as_str().unwrap().to_owned())
                    .collect();
                e.sort();
                e
            };
            if codes_of(&found) != expected {
                failures.push(format!(
                    "{name}: expected {expected:?}, got {:?}",
                    codes_of(&found)
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{} of {} failed:\n{}",
            failures.len(),
            cases.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn dataset_write_reports_the_names_category() {
        let found = scan("document.body.dataset.history = 'x';");
        assert_eq!(codes_of(&found), ["navigation"]);
        let plain = scan("document.body.dataset.foo = 'x';");
        assert_eq!(codes_of(&plain), ["bad-write"]);
    }

    #[test]
    fn wrap_is_the_exact_page_text() {
        assert_eq!(wrap("x;"), "(function(){\"use strict\";\nx;\n})");
        assert_eq!(wrap(""), "(function(){\"use strict\";\n\n})");
    }

    #[test]
    fn policy_tables_load() {
        assert_eq!(POLICY.as_ref().err(), None);
        let raw: RawPolicy = serde_json::from_str(POLICY_JSON).unwrap();
        assert_eq!(raw.codes, CODE_NAMES);
    }

    #[test]
    fn positions_are_in_the_scripts_own_text() {
        let found = scan("console.log(1);\n  fetch('x');");
        assert_eq!((found[0].line, found[0].column), (2, 2));
        let first_line = scan("fetch('x');");
        assert_eq!((first_line[0].line, first_line[0].column), (1, 0));
        let wide = scan("const s = '🚫é'; fetch('x');");
        assert_eq!((wide[0].line, wide[0].column), (1, 17));
        let crlf = scan("1;\r\nconsole.log(1);\r\n\r\nfetch(1);");
        assert_eq!(crlf[0].line, 4);
    }

    #[test]
    fn findings_are_sorted_unique_and_capped() {
        let many = "fetch(1);".repeat(80);
        let found = scan(&many);
        assert_eq!(found.len(), 50);
        assert!(
            found
                .windows(2)
                .all(|w| (w[0].line, w[0].column) < (w[1].line, w[1].column))
        );
        assert!(found.iter().all(|f| f.message.chars().count() <= 160));
    }

    #[test]
    fn messages_do_not_echo_long_script_text() {
        let long = "a".repeat(300);
        let found = scan(&format!("{long}();"));
        assert!(found[0].message.chars().count() <= 160);
        assert!(!found[0].message.contains(&"a".repeat(50)));
    }

    #[test]
    fn check_shape_accepts_bodies_and_refuses_escapes() {
        assert_eq!(check_shape(""), None);
        assert_eq!(check_shape("return 1;"), None);
        assert_eq!(check_shape("fetch('x'); var a = 1; function f(){}"), None);
        for escape in [
            "}); evil(); (function(){",
            "}), (function(){",
            "const = ;",
            "'x",
        ] {
            assert_eq!(
                check_shape(escape).map(|f| f.code),
                Some(SYNTAX),
                "{escape}"
            );
        }
        let big = "a;".repeat(MAX_CODE_BYTES);
        assert_eq!(check_shape(&big).map(|f| f.code), Some(SIZE));
    }

    #[test]
    fn deep_nesting_is_refused_before_parsing() {
        let deep = format!("{}1{}", "(".repeat(40), ")".repeat(40));
        assert_eq!(codes_of(&scan(&deep)), ["nesting"]);
        let legit = format!("const a = {}1{};", "(".repeat(30), ")".repeat(30));
        assert!(scan(&legit).is_empty());
        let objects = format!("const a = {}1{};", "{a:".repeat(31), "}".repeat(31));
        assert!(scan(&objects).is_empty());
        let arrays = format!("const a = {}1{};", "[".repeat(31), "]".repeat(31));
        assert!(scan(&arrays).is_empty());
    }

    #[test]
    fn max_size_chains_fit_the_scan_stack() {
        let inputs = [
            "1+".repeat(8000),
            "!".repeat(16000),
            format!("a{}", ".b".repeat(8000)),
            "a?b:".repeat(4000),
            "a=>".repeat(5000),
            "if(a)".repeat(3000),
            "a=".repeat(8000),
            "a?.b".repeat(4000),
        ];
        for input in inputs {
            let owned = input.clone();
            let out = on_big_stack(SCAN_STACK_BYTES, move || scan_text(&owned));
            assert!(out.is_some());
        }
    }

    #[test]
    fn long_bracketless_chains_do_not_overflow() {
        let chain = format!("const a = {}1;", "1 + ".repeat(3000));
        let _ = scan(&chain);
        let nots = format!("const a = {}1;", "!".repeat(5000));
        let _ = scan(&nots);
        let members = format!("a{};", ".b".repeat(5000));
        let _ = scan(&members);
        let ifs = format!("{}a;", "if(a)".repeat(3000));
        let _ = scan(&ifs);
    }

    #[test]
    fn scan_survives_garbage() {
        let nasties = [
            "",
            "\0",
            "}",
            "{{{{",
            "(((",
            "`${",
            "/*",
            "'\\",
            "\u{FEFF}",
            "a?.",
            "a?.[",
            "for(",
            "=>",
            "...",
            "#!x",
            "\\u{110000}",
            "\u{10FFFF}",
            "a.#b",
            "new.target",
            "import.meta",
            "super()",
            "async()=>{await 1}",
            "`${`${`${1}`}`}",
            "({a:1}=1)",
            "[,,,]",
            "const {a:{b:{c}}} = x;",
            "for(const [a=1] of b);",
            "x = /[/",
            "`\\u{`",
        ];
        for text in nasties {
            let _ = scan(text);
            let _ = check_shape(text);
        }
    }

    #[test]
    fn scan_survives_mutated_vectors() {
        let file: Value = serde_json::from_str(VECTORS).unwrap();
        let mut seed = 0x2545_F491_u32;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as usize
        };
        for case in file["cases"].as_array().unwrap() {
            let code = case_code(case);
            if code.len() > 2000 {
                continue;
            }
            let chars: Vec<char> = code.chars().collect();
            let cut: String = chars[..next() % (chars.len() + 1)].iter().collect();
            let _ = scan(&cut);
            let mut mutated = chars.clone();
            for _ in 0..3 {
                if !mutated.is_empty() {
                    let at = next() % mutated.len();
                    mutated[at] = ['(', '{', '`', '\'', '.', '=', '/', '[', '\u{2028}'][next() % 9];
                }
            }
            let _ = scan(&mutated.iter().collect::<String>());
        }
    }
}
