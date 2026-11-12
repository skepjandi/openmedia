# Script Policy

> **Status: Implemented in the app (Rust) and the Worker; not production-verified.** This page is the contract for `script` rules and for the scanner that decides which scripts bundled community recipes and imports may carry. Two implementations must agree with it: Rust (`src-tauri/src/recipes/script_policy.rs`) and the Worker (`src/scan.ts` in `openmedia-worker`). The tables live in `shared/script-policy/policy.json` and the conformance cases in `shared/script-policy/vectors.json`; both repos carry a copy and both test suites run every case.

## Three tiers

| Where the recipe comes from | Script rules | Who checks | Why |
|---|---|---|---|
| The user's own assistant (`origin: ai`), saved after the user accepts the preview | **Any JavaScript.** Nothing is refused. The proposal shows the code and a plain list of the powers it uses (network, storage, navigation, automation…) before the user accepts | The user, looking at the preview. The scanner only *reports* | The user asked for it, on their own device and session |
| A shared recipe in the share Worker (before the pull request) and in CI | Only scripts that pass the policy below. Anything else is rejected before a pull request is opened, and the reply names the findings | The Worker, automatically, then a maintainer | A merged script ships in the app and runs in strangers' logged-in sessions |
| Bundled community recipe (`origin: imported`) | The same policy, enforced in Rust when the recipe is parsed. A script that fails is refused, never run | Rust | The app does not trust a file because of where it came from |

The policy exists to make one promise: **a script that passes cannot send data anywhere.** It has no network API, no storage or cookie API, no navigation, no dynamic code, no way to build markup, and no way to click, submit or type for the user. It can read and restyle the page it runs on, and add small widgets of its own.

## The script rule

```json
{ "id": "hide-sponsored", "label": "Hide sponsored posts", "type": "script",
  "option": "sponsored", "on": ["https://www.example.com/*"], "code": "…" }
```

`option` and `on` behave as on every rule. `code` is the body of a function (no `function` wrapper of its own; `return` is allowed). `deny_unknown_fields` applies; there is no `target`.

| Limit | Value |
|---|---|
| `code` per rule | 16 384 UTF-8 bytes |
| script rules per recipe | 8 |
| `code` in all rules of a recipe | 32 768 bytes |

`origin: ai` and `user` recipes get only the size limits and the *shape* check (below); `imported` recipes get the whole policy.

### Execution

The page script wraps each applicable rule and runs it once per page load in every frame whose own URL matches, after `DOMContentLoaded` (at once when the document is past it). Exceptions are swallowed. The text that runs is exactly

```
(function(){"use strict";\n<code>\n})
```

and the scanner parses **that exact text**, so what was checked is what runs. The parse must give one statement, an expression statement holding a function expression with no name, no parameters, not async and not a generator, whose first body statement is the `"use strict"` directive. Code that closes the wrapper early (`}); evil(); (function(){`) fails this shape check with `syntax`. Scripts are strict-mode.

## The policy

The scanner returns a list of findings; a script passes when the list is empty. A finding is `{ code, message, line, column }` (line and column count in `code`, from 1 and 0). At most 50 are kept, sorted by position, one per `(code, line, column)`.

**The policy is default-deny.** A syntax node, global, property name, event, attribute, tag or CSS property that is not in `policy.json` is refused. Adding anything to those tables is a security change that needs review in both repos, a `version` bump and new vectors.

### Step 0: the text (stops at the first failure)

1. More than `limits.codeBytes` bytes: `size`.
2. A control character other than tab, line feed and carriage return, an unpaired surrogate, U+2028/2029, U+200B–U+200F, U+202A–U+202E, U+2066–U+2069 or U+FEFF anywhere (`unsafeTextPattern`): `text`.
3. The text `<!--` or `-->` anywhere: `html-comment` (the engines treat them as comments in scripts).
4. Brackets `( [ {` nested deeper than `limits.bracketDepth`, counting raw characters: `nesting`.

### Step 1: parse and shape

Parse as a Script (not a module), latest ECMAScript, parentheses not kept as nodes. A parse error is `syntax`. Wrong shape is `syntax`. Stop after either.

### Step 2: walk

Every node is visited once; more than `limits.nodes` nodes is `size` and stops. A node whose type is not in `nodeTypes` is `syntax-not-allowed` and **its children are not interpreted**: they are *swept* instead (see below). The only loops are `for`, `for…in` and `for…of`; there are no classes, no function declarations, no `async`/`await`/generators, no `while`/`do`, no labels, no `with`, no `debugger`, no `import`, no tagged templates, no getters/setters.

**Sweep.** Refused syntax is not interpreted, but a script must still show what it can do: a `fetch` inside a function declaration, a class or an `async` function is a network power the user has to see. So a refused node (a refused type, or one of the refused forms below that carry children: `var`, `async` or generator functions, `for await`, a refused unary operator, getters and setters) is swept: every `Identifier` and every string `Literal` anywhere under it whose name or value is in `sweepNames` is reported with the topical code of its category. `sweepNames` is the short list of names that are almost never an innocent variable name (`fetch`, `cookie`, `eval`, `innerHTML`, `localStorage`, …), so `data`, `value` or `src` as a parameter name are not reported. The sweep reads names only; obfuscation (`window['fe'+'tch']` in refused syntax) is not seen, which is why the assistant also shows the code.

Further syntax rules, each `syntax-not-allowed`: `var` (only `const` and `let`); `async` or generator functions; a `for` with no test (`for(;;)`); `for await`; unary `delete` (allowed unary operators: `unaryOperators`); BigInt literals; object-literal getters, setters; `break`/`continue` with a label; a `catch` parameter that is not a plain identifier.

**Identifiers.** Every identifier name, as the parser decodes it (so `\u0066etch` is `fetch`), must match `^[A-Za-z_$][A-Za-z0-9_$]*$`, else `text`. A declared name may not be in `bannedBindings` or `reservedBindings` (`dynamic-code` if the name has a category, else `syntax-not-allowed`).

**Scope.** Real block scoping with `const` and `let` only (so nothing hoists out of its block): the wrapper function, every function, every block, `for`/`for…in`/`for…of` head, `switch` body and `catch` clause open a scope; a block's declarations are visible in the whole block (a use before the declaration still resolves to it). A function expression's own name is bound inside it. A reference that resolves to a local binding is fine and is not checked again. A reference that resolves to no binding must be in `globals`; if not, its finding code is its category from `categories` or `global-not-allowed`.

**Properties.** A property name is looked up without looking at the receiver, so each allowed name must be safe on any object.

- `obj.name`: `name` must be in `members`; else its category code or `member-not-allowed`.
- `obj[expr]`: only when `expr` is an integer literal 0 to 1 000 000; else `computed-access`. This applies to optional chains too.
- `obj.dataset.anything` may read any name; writes need the prefix `datasetWritePrefix`. `obj.style.name` may use only the camel-case names of `styleProperties` (plus `setProperty`, `removeProperty`, `getPropertyValue`). These two rules look at the syntax `X.dataset.` and `X.style.`; an alias (`const s = el.style; s.display`) does not get them and fails.
- `location` is allowed only as `X.location.<name>` with `<name>` in `locationReads`, not called and not assigned; any other use is `navigation`.
- Destructuring keys (`const { body } = document`) follow the `obj.name` rule.
- Object-literal keys: any name except `bannedBindings` (and not computed: `computed-access`). Reading a key of an object the script built (`o.a`) is not allowed, since `a` is not in `members`; use `Map`, `Set`, arrays and local variables.

**Calls with restricted arguments.** These names (`restrictedCalls`) may appear only as the callee of a call (`el.setAttribute(…)`), never as a value (`const f = el.setAttribute`), else `bad-argument`. Their arguments:

- `createElement(tag)`: exactly one string literal in `createTags`.
- `setAttribute(name, value)`: exactly two arguments; `name` a string literal in `attributes` or starting with one of `attributePrefixes`; `value` anything.
- `addEventListener` / `removeEventListener(type, …)`: at least two arguments; `type` a string literal in `events`.
- `setProperty(name, value[, "important"])`: literals; `name` in `styleProperties`; `value` safe (below). `removeProperty(name)`: a literal in `styleProperties`.
- `setTimeout`, `setInterval`, `requestAnimationFrame`, `requestIdleCallback` (as a global or a member): the first argument is an arrow or function expression, or an identifier bound by `const x = <arrow or function expression>`. A string would be evaluated as code.
- `new X(…)`: `X` must be an identifier in `constructors`; a global that is not one is `bad-argument`.

**Writes.** The target of `=`, a compound assignment or `++`/`--`:

- An identifier must be a local binding; assigning a global (`console = …`) is `bad-write`.
- A member: the property must be in `writeMembers`, else its category or `bad-write`. `X.dataset.name` needs the prefix. `X.style.name` needs `name` in `styleProperties`, operator `=` and a safe value literal.
- The text sinks `textContent` and `innerText` (`textSinks`) take any value and operator when the receiver is an identifier bound by a **created element** (below). On any other receiver the operator must be `=` and the value a **safe text literal**, else `bad-write`. This is what stops a script from filling a page `<style>` with `@import` rules: a stylesheet's text is its text children.

**Created elements.** `const x = document.createElement("div")` (the global `document`, one argument, a tag in `createTags`) makes `x` a created element. The tags have no meaning for scripts, styles or addresses, and cannot be given one.

**Inserting nodes.** `append`, `prepend`, `before`, `after`, `replaceWith`, `replaceChildren` (all arguments) and `appendChild`, `insertBefore`, `replaceChild` (first argument) on a receiver that is not a created element may only be given created elements or a direct `document.createElement(…)` call; a string, a spread, a node from the page (including a text node) or anything else is `insert-not-allowed`. A script can move only what it built, so it cannot put page text into a `<style>` or a `<script>`.

**Safe values.** A *safe style value* is a string or number literal (a string at most `styleValueChars` characters, matching `styleValuePattern`) whose function names are all in `styleFunctions` (so `url(…)`, `image-set(…)`, `src(…)` are out). A *safe text literal* is a number, a string or an interpolation-free template of at most `textLiteralChars` characters, with none of `@ \ { } < >` and no `://`, and, ignoring whitespace and case, no `url(`, `image-set(`, `src(`, `element(` or `expression(`.

**Regular expressions.** A regex literal is `regex` when its source matches `[+*}]\)[+*{]` (a quantified group that is quantified again: it can take very long), when its flags are not within `gimsuy`, or when its source contains `(?<` (lookbehind and named groups). A script is embedded as raw source in the one page script, so a regular expression that an older WebView cannot parse would be a syntax error that stops every recipe on that page; the flags and constructs above are the ones that engines added last.

### Finding codes

`syntax`, `size`, `text`, `nesting`, `html-comment`, `syntax-not-allowed`, `network`, `storage`, `dynamic-code`, `markup`, `navigation`, `automation`, `credentials`, `global-not-allowed`, `member-not-allowed`, `computed-access`, `bad-argument`, `bad-write`, `insert-not-allowed`, `regex`. The five topical codes (`network` … `credentials`) come from `categories`: a refused identifier or property name found there reports its category, so the message can say *what* the script was trying to do. The shell turns codes into sentences.

## What this does and does not give

- **No egress by construction.** Requests need a network API (`fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `Image`), an element with an address (`img`, `a`, `iframe`, `link`, `script`, `form`), an attribute that carries an address (`src`, `href`, `action`, `data-*`, `style`, `srcset`), a stylesheet (`@import`, `url()`), navigation, or code built from strings. The policy has none of these and no way to get one: names are fixed at write time, computed property access is gone, and no string is ever evaluated.
- **No secrets to take.** No cookie, no storage, no input values, no clipboard.
- **No acting for the user.** No click, submit, focus, dispatched event, prompt or navigation.
- **Not covered:** a script can still use the CPU (a loop that never ends; `for(;;)` and `while` are refused but `for(let i=0;true;i++)` is not), slow the page, hide or rewrite things the user needs (a script can say "Your session expired"), and call page-defined functions only through names already in `members`. The policy is a static check of source text; engine behaviour I did not list is [INFERENCE] safe. Defense in depth is the human review of every pull request that adds a recipe, and the fact that nothing reaches users except in an app release, not this page alone.

## Changing the policy

The policy is code that ships with the app, so a release can make it stricter. An installed recipe that no longer passes is skipped when the recipes load (`Recipes::load` skips every invalid file; the file stays on disk), so it stops running and the app still starts. Making the policy looser is a security change: both repos, a `version` bump in `policy.json`, new vectors, and the Worker and CI updated before a recipe that needs the new rule is merged, because the app re-checks every bundled recipe.

## Conformance

`shared/script-policy/vectors.json` is `{ "version", "cases": [{ "name", "code" | "generate", "ok" | "codes" }] }`. A case with `ok: true` must give no findings; otherwise the set of finding codes must equal `codes` exactly. `generate` is `{ "repeat", "times" }` (the code is `repeat` repeated `times` times) or `{ "open", "close", "times", "inner" }`. Each suite runs every case; a divergence is a bug in one implementation or a gap in this page, and the fix lands in both repos together.

## See also

[Recipe Library and Sharing](./recipe-library.md) · [Recipe Format](./recipe-format.md) · [Security](./security.md) · [AI Assistant](./ai-assistant.md)
