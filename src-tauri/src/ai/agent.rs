//! The request flow: snapshot the page, ask the model, preview its answer on the page, check what
//! it matched, repair, and on accept save it. Everything that touches the page or the provider
//! goes through [`Page`] and [`Model`], so the flow is tested with fakes.

use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    sync::{Mutex, PoisonError},
    time::Instant,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::{
    ProviderConfig,
    activity::{Activity, StepKind, StepStatus},
    patch::{self, Patch, PatchRule},
    prompt::{self, EarlierTurn, Prompt, PromptInput, RepairNote, RuleFailure},
    redact,
    snapshot::{self, Snapshot},
};
use crate::error::{Error, Result};
use crate::recipes::{OptionGroup, Recipe, Rule, script_policy};

const MAX_REQUEST_CHARS: usize = 500;
const MAX_JOBS: usize = 8;
/// Rounds after the first answer that may repair rules which matched nothing.
const MAX_REPAIRS: u8 = 2;

const MSG_BAD_ANSWER: &str = "The model's answer was not in the expected form.";
const MSG_NO_JOB: &str = "That request has expired. Ask again.";
const MSG_BAD_PAGE: &str = "The page could not be read.";
const MSG_PAGE_CHANGED: &str = "The page changed since this request was prepared. Ask again.";
const MSG_CANCELLED: &str = "That request was cancelled.";

/// Scripts that tie a job to the document it was prepared on. The token lives in the page's own
/// symbol registry under a random name only this job knows, so another page (another session, or
/// the same session after it navigated) cannot answer for it.
const PAGE_MARK_PREFIX: &str =
    "(function(){var k=Symbol.for('openmedia.jobs');var j=window[k]||(window[k]={});j[";
const PAGE_CHECK_PREFIX: &str =
    "(function(){var j=window[Symbol.for('openmedia.jobs')];return !!(j&&j[";

fn mark_page(page: &impl Page, token: &str) -> Result<()> {
    page.evaluate(format!("{PAGE_MARK_PREFIX}'{token}']=1;return 1}})()"))?;
    Ok(())
}

/// Refuses to go on when the page the user approved is no longer the one being read or changed.
fn ensure_same_page(page: &impl Page, token: &str) -> Result<()> {
    let same = page.evaluate(format!("{PAGE_CHECK_PREFIX}'{token}']===1)}})()"))?;
    if same.trim() == "true" {
        Ok(())
    } else {
        Err(Error::Connection(MSG_PAGE_CHANGED.to_owned()))
    }
}

/// Runs scripts in the page the user is looking at. Answers are hostile data.
pub trait Page {
    fn evaluate(&self, script: String) -> Result<String>;
}

/// Asks the chosen model for a patch (JSON text).
pub trait Model {
    fn complete(
        &self,
        prompt: &Prompt,
        schema: &Value,
    ) -> impl Future<Output = Result<String>> + Send;
}

/// What the shell shows before anything is sent.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRequest {
    pub id: Uuid,
    pub provider_name: String,
    pub model: Option<String>,
    /// The site the request is about, as the registrable domain: a chat belongs to it.
    pub domain: String,
    /// The recipe that already covers the page, when one does.
    pub recipe_id: Option<String>,
    pub recipe_name: Option<String>,
    pub payload: String,
    pub token_estimate: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProposalKind {
    ExistingOption,
    NewOption,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalOption {
    pub id: Option<String>,
    pub label: String,
    pub description: String,
    pub group: OptionGroup,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalRule {
    pub label: String,
    #[serde(default)]
    pub kind: ProposalRuleKind,
    /// Empty for a script rule.
    pub selector: String,
    /// Elements a style rule matches now; 0 for a script rule, which is never counted.
    pub matches: i64,
    /// The script, exactly as it will be saved and run; only for a script rule.
    #[serde(default)]
    pub code: Option<String>,
    /// What the script can do that the shared-recipe script policy refuses; empty for a style rule.
    #[serde(default)]
    pub powers: Vec<Power>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProposalRuleKind {
    #[default]
    Style,
    Script,
}

/// One policy finding on a script, shown to the user before they accept it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Power {
    pub code: String,
    pub message: String,
    pub line: u32,
}

impl ProposalRule {
    fn style(label: String, selector: String, matches: i64) -> Self {
        Self {
            label,
            kind: ProposalRuleKind::Style,
            selector,
            matches,
            code: None,
            powers: Vec::new(),
        }
    }

    fn script(label: String, code: String) -> Self {
        let powers = script_policy::scan(&code)
            .into_iter()
            .map(|finding| Power {
                code: finding.code.to_owned(),
                message: finding.message,
                line: finding.line,
            })
            .collect();
        Self {
            label,
            kind: ProposalRuleKind::Script,
            selector: String::new(),
            matches: 0,
            code: Some(code),
            powers,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Proposal {
    pub id: Uuid,
    pub kind: ProposalKind,
    pub summary: String,
    pub recipe_id: String,
    pub recipe_name: String,
    pub option: ProposalOption,
    pub rules: Vec<ProposalRule>,
    /// Style rules that matched no element on the page.
    pub unmatched: usize,
    /// Whether accepting saves a script that runs on the site's pages.
    #[serde(default)]
    pub runs_code: bool,
    /// Whether every script is within the shared-recipe script policy, so the recipe could be shared.
    #[serde(default = "default_publishable")]
    pub publishable: bool,
}

/// Saved chats from before script rules hold style-only proposals, which are always shareable.
fn default_publishable() -> bool {
    true
}

/// Everything about one request that has to outlive a command call.
#[derive(Clone)]
pub struct Job {
    pub request: String,
    pub domain: String,
    pub provider: ProviderConfig,
    /// The recipe that already covers the page, if any.
    pub base: Option<Recipe>,
    pub option_states: BTreeMap<String, bool>,
    pub earlier: Vec<EarlierTurn>,
    pub snapshot: Snapshot,
    pub patch: Option<Patch>,
    /// Names this job in the page it was prepared on; see [`ensure_same_page`].
    page_token: String,
    created: Instant,
}

/// The jobs waiting for the user: prepared, or proposed and not yet accepted or rejected.
#[derive(Default)]
pub struct Agent(Mutex<HashMap<Uuid, Job>>);

impl Agent {
    fn jobs(&self) -> std::sync::MutexGuard<'_, HashMap<Uuid, Job>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn insert(&self, job: Job) -> Uuid {
        let id = Uuid::new_v4();
        let mut jobs = self.jobs();
        if jobs.len() >= MAX_JOBS
            && let Some(oldest) = jobs
                .iter()
                .min_by_key(|(_, job)| job.created)
                .map(|(id, _)| *id)
        {
            jobs.remove(&oldest);
        }
        jobs.insert(id, job);
        id
    }

    /// Whether the job still exists: rejecting it (Cancel) removes it while a send may be running.
    fn is_live(&self, id: Uuid) -> bool {
        self.jobs().contains_key(&id)
    }

    pub fn get(&self, id: Uuid) -> Result<Job> {
        self.jobs()
            .get(&id)
            .cloned()
            .ok_or_else(|| Error::Connection(MSG_NO_JOB.to_owned()))
    }

    pub fn discard(&self, id: Uuid) -> Option<Job> {
        self.jobs().remove(&id)
    }

    fn set_patch(&self, id: Uuid, patch: Patch) {
        if let Some(job) = self.jobs().get_mut(&id) {
            job.patch = Some(patch);
        }
    }
}

/// The recipe that already covers the page, found once the page's host is known.
pub struct RecipeContext {
    pub base: Option<Recipe>,
    pub option_states: BTreeMap<String, bool>,
}

/// What `ai_prepare` needs to know that only the commands can look up.
pub struct PrepareInput<F: FnOnce(&str, &str) -> RecipeContext> {
    pub request: String,
    pub provider: ProviderConfig,
    /// The earlier requests of the chat this one continues; only the user's words and outcomes.
    pub earlier: Vec<EarlierTurn>,
    /// Given the page's host and path.
    pub context: F,
}

fn snapshot_of(page: &impl Page) -> Result<Snapshot> {
    let json = page.evaluate(snapshot::SNAPSHOT_SCRIPT.to_owned())?;
    let mut snapshot = snapshot::parse_snapshot(&json)?;
    redact::redact(&mut snapshot);
    Ok(snapshot)
}

fn build_prompt(job: &Job, snapshot: &Snapshot, repair: Option<RepairNote<'_>>) -> Prompt {
    prompt::build(&PromptInput {
        request: &job.request,
        host: &snapshot.host,
        path: &snapshot.path,
        recipe: job.base.as_ref(),
        option_states: &job.option_states,
        snapshot,
        playbook: prompt::site_section(&snapshot.host),
        repair,
        earlier: &job.earlier,
    })
}

/// Reads the page, builds the prompt and remembers the job. Nothing leaves the device here.
pub fn prepare<F: FnOnce(&str, &str) -> RecipeContext>(
    agent: &Agent,
    page: &impl Page,
    input: PrepareInput<F>,
) -> Result<PreparedRequest> {
    let request = input.request.trim().to_owned();
    if request.is_empty() || request.chars().count() > MAX_REQUEST_CHARS {
        return Err(Error::Connection(format!(
            "A request needs 1-{MAX_REQUEST_CHARS} characters."
        )));
    }
    let snapshot = snapshot_of(page)?;
    let domain = tauri_plugin_siteview::site::registrable_domain(&snapshot.host)
        .ok_or_else(|| Error::Connection(MSG_BAD_PAGE.to_owned()))?;
    let context = (input.context)(&snapshot.host, &snapshot.path);
    let page_token = Uuid::new_v4().simple().to_string();
    mark_page(page, &page_token)?;
    let job = Job {
        request,
        domain,
        provider: input.provider,
        base: context.base,
        option_states: context.option_states,
        earlier: input.earlier,
        snapshot,
        patch: None,
        page_token,
        created: Instant::now(),
    };
    let prompt = build_prompt(&job, &job.snapshot, None);
    let prepared = |id| PreparedRequest {
        id,
        provider_name: job.provider.name.clone(),
        model: job.provider.model.clone(),
        domain: job.domain.clone(),
        recipe_id: job.base.as_ref().map(|recipe| recipe.id.clone()),
        recipe_name: job.base.as_ref().map(|recipe| recipe.name.clone()),
        payload: prompt::payload_preview(&prompt),
        token_estimate: prompt::estimate_tokens(&prompt),
    };
    let id = agent.insert(job.clone());
    Ok(prepared(id))
}

/// The style rules the page is asked to count, and the css that previews them. Script rules are
/// neither counted nor previewed: they run only after the user accepts.
fn selectors_and_css(patch: &Patch, base: Option<&Recipe>) -> (Vec<(String, String)>, String) {
    match (patch, base) {
        (Patch::NewOption { rules, .. }, _) => (
            rules
                .iter()
                .filter_map(|rule| match rule {
                    PatchRule::Style {
                        label, selector, ..
                    } => Some((label.clone(), selector.clone())),
                    PatchRule::Script { .. } => None,
                })
                .collect(),
            patch::preview_css(patch),
        ),
        (Patch::ExistingOption { option_id, .. }, Some(recipe)) => (
            recipe
                .rules
                .iter()
                .filter_map(|rule| match rule {
                    Rule::Hide {
                        label,
                        option: Some(option),
                        target,
                        ..
                    } if option == option_id => Some((label.clone(), target.css.clone())),
                    _ => None,
                })
                .collect(),
            patch::option_css(recipe, option_id),
        ),
        (Patch::ExistingOption { .. }, None) => (Vec::new(), String::new()),
    }
}

fn counts_of(page: &impl Page, selectors: &[String]) -> Result<Vec<i64>> {
    if selectors.is_empty() {
        return Ok(Vec::new());
    }
    let json = page.evaluate(snapshot::count_script(selectors))?;
    let counts: Vec<i64> =
        serde_json::from_str(&json).map_err(|_| Error::Connection(MSG_BAD_PAGE.to_owned()))?;
    if counts.len() == selectors.len() {
        Ok(counts)
    } else {
        Err(Error::Connection(MSG_BAD_PAGE.to_owned()))
    }
}

/// The rules as the user sees them: in the answer's order, style rules with their counts.
fn shown_rules(
    patch: &Patch,
    styles: Vec<(String, String)>,
    counts: Vec<i64>,
) -> Vec<ProposalRule> {
    let mut counted = styles
        .into_iter()
        .zip(counts)
        .map(|((label, selector), matches)| ProposalRule::style(label, selector, matches));
    match patch {
        Patch::ExistingOption { .. } => counted.collect(),
        Patch::NewOption { rules, .. } => rules
            .iter()
            .filter_map(|rule| match rule {
                PatchRule::Style { .. } => counted.next(),
                PatchRule::Script { label, code } => {
                    Some(ProposalRule::script(label.clone(), code.clone()))
                }
            })
            .collect(),
    }
}

fn proposal_for(id: Uuid, job: &Job, patch: &Patch, rules: Vec<ProposalRule>) -> Proposal {
    let unmatched = rules
        .iter()
        .filter(|rule| rule.kind == ProposalRuleKind::Style && rule.matches <= 0)
        .count();
    let runs_code = rules
        .iter()
        .any(|rule| rule.kind == ProposalRuleKind::Script);
    let publishable = rules.iter().all(|rule| rule.powers.is_empty());
    let (kind, option) = match patch {
        Patch::NewOption {
            label,
            description,
            group,
            ..
        } => (
            ProposalKind::NewOption,
            ProposalOption {
                id: None,
                label: label.clone(),
                description: description.clone(),
                group: *group,
            },
        ),
        Patch::ExistingOption { option_id, .. } => {
            let existing = job
                .base
                .as_ref()
                .and_then(|recipe| recipe.option(option_id));
            (
                ProposalKind::ExistingOption,
                ProposalOption {
                    id: Some(option_id.clone()),
                    label: existing.map(|o| o.label.clone()).unwrap_or_default(),
                    description: existing.map(|o| o.description.clone()).unwrap_or_default(),
                    group: existing.map_or(OptionGroup::Content, |o| o.group),
                },
            )
        }
    };
    // A new switch is saved in the user's own recipe for the site, never in an installed one.
    let target = match patch {
        Patch::ExistingOption { .. } => job.base.as_ref(),
        Patch::NewOption { .. } => job.base.as_ref().filter(|recipe| patch::is_made(recipe)),
    };
    Proposal {
        id,
        kind,
        summary: patch.summary().to_owned(),
        recipe_id: target.map_or_else(|| format!("custom.{}", job.domain), |r| r.id.clone()),
        recipe_name: target.map_or_else(|| job.domain.clone(), |r| r.name.clone()),
        option,
        rules,
        unmatched,
        runs_code,
        publishable,
    }
}

/// Sends the prepared request, previews the answer on the page, and repairs rules that matched
/// nothing (at most [`MAX_REPAIRS`] more rounds). The preview stays on the page until the user
/// accepts or rejects. `progress` hears every step as it starts and ends, so the shell can show
/// what is happening while the model thinks.
pub async fn send(
    agent: &Agent,
    page: &impl Page,
    model: &impl Model,
    progress: &(impl Fn(Activity) + Sync),
    id: Uuid,
) -> Result<Proposal> {
    let job = agent.get(id)?;
    let schema = patch::patch_schema();
    let mut snapshot = job.snapshot.clone();
    let mut previous: Option<String> = None;
    let mut failures: Vec<(String, String, i64)> = Vec::new();
    let mut validation_error: Option<String> = None;

    for round in 0..=MAX_REPAIRS {
        let borrowed: Vec<RuleFailure<'_>> = failures
            .iter()
            .map(|(label, selector, matches)| RuleFailure {
                label,
                selector,
                matches: *matches,
            })
            .collect();
        let repair = (round > 0).then(|| RepairNote {
            round,
            previous_answer: previous.as_deref(),
            failures: &borrowed,
            validation_error: validation_error.as_deref(),
        });
        if round > 0 {
            let step = Activity::new(StepKind::Repair, StepStatus::Done, round);
            progress(if validation_error.is_some() {
                step
            } else {
                step.with_total(failures.len())
            });
        }
        let prompt = build_prompt(&job, &snapshot, repair);
        progress(Activity::new(
            StepKind::AskModel,
            StepStatus::Running,
            round,
        ));
        let answer = match model.complete(&prompt, &schema).await {
            Ok(answer) => answer,
            Err(error) => {
                progress(Activity::new(StepKind::AskModel, StepStatus::Failed, round));
                return Err(error);
            }
        };
        progress(Activity::new(StepKind::AskModel, StepStatus::Done, round));
        // Cancel while the model was thinking: stop before touching the page or paying again.
        if !agent.is_live(id) {
            return Err(Error::Connection(MSG_CANCELLED.to_owned()));
        }

        let patch = match patch::parse_patch(&answer, job.base.as_ref()) {
            Ok(patch) => {
                progress(Activity::new(
                    StepKind::CheckAnswer,
                    StepStatus::Done,
                    round,
                ));
                patch
            }
            Err(error) if round < MAX_REPAIRS => {
                progress(Activity::new(
                    StepKind::CheckAnswer,
                    StepStatus::Failed,
                    round,
                ));
                validation_error = Some(error.to_string());
                previous = Some(answer);
                failures.clear();
                continue;
            }
            Err(_) => {
                progress(Activity::new(
                    StepKind::CheckAnswer,
                    StepStatus::Failed,
                    round,
                ));
                return Err(Error::Connection(MSG_BAD_ANSWER.to_owned()));
            }
        };

        let (rules, css) = selectors_and_css(&patch, job.base.as_ref());
        let selectors: Vec<String> = rules.iter().map(|(_, selector)| selector.clone()).collect();
        ensure_same_page(page, &job.page_token)?;
        page.evaluate(snapshot::preview_script(&css))?;
        progress(
            Activity::new(StepKind::PreviewOnPage, StepStatus::Done, round).with_total(rules.len()),
        );
        let counts = counts_of(page, &selectors)?;
        let failed: Vec<(String, String, i64)> = rules
            .iter()
            .zip(&counts)
            .filter(|(_, count)| **count <= 0)
            .map(|((label, selector), count)| (label.clone(), selector.clone(), *count))
            .collect();
        progress(
            Activity::new(StepKind::CountMatches, StepStatus::Done, round)
                .with_matched(rules.len() - failed.len())
                .with_total(rules.len()),
        );

        if failed.is_empty() || round == MAX_REPAIRS {
            let shown = shown_rules(&patch, rules, counts);
            let proposal = proposal_for(id, &job, &patch, shown);
            agent.set_patch(id, patch);
            return Ok(proposal);
        }

        ensure_same_page(page, &job.page_token)?;
        snapshot = snapshot_of(page)?;
        failures = failed;
        validation_error = None;
        previous = Some(answer);
    }
    Err(Error::Connection(MSG_BAD_ANSWER.to_owned()))
}

/// Takes the preview off the page and forgets the job.
pub fn reject(agent: &Agent, page: &impl Page, id: Uuid) {
    agent.discard(id);
    let _ = page.evaluate(snapshot::clear_preview_script());
}

/// What accepting changes.
pub enum Accepted {
    /// Turn this existing option on.
    EnableOption {
        recipe_id: String,
        option_id: String,
    },
    /// Save this recipe as a `custom.` recipe.
    SaveRecipe(Box<Recipe>),
}

/// Works out what accepting means and drops the job. Saving and reloading are the caller's, so
/// that a failure there leaves nothing half done.
pub fn accept(agent: &Agent, page: &impl Page, id: Uuid) -> Result<Accepted> {
    let job = agent.get(id)?;
    let patch = job
        .patch
        .as_ref()
        .ok_or_else(|| Error::Connection(MSG_NO_JOB.to_owned()))?;
    let accepted = match patch {
        Patch::ExistingOption { option_id, .. } => {
            let recipe = job
                .base
                .as_ref()
                .ok_or_else(|| Error::Connection(MSG_NO_JOB.to_owned()))?;
            Accepted::EnableOption {
                recipe_id: recipe.id.clone(),
                option_id: option_id.clone(),
            }
        }
        Patch::NewOption { .. } => Accepted::SaveRecipe(Box::new(patch::apply_patch(
            job.base.as_ref(),
            &job.domain,
            patch,
        )?)),
    };
    agent.discard(id);
    let _ = page.evaluate(snapshot::clear_preview_script());
    Ok(accepted)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;
    use crate::ai::ProviderKind;
    use crate::recipes::official_recipes;

    const SNAPSHOT: &str = r#"{"v":1,"host":"www.example.org","path":"/","w":390,"vw":"phone","sl":false,"tr":false,"root":{"t":"body","k":[{"t":"div","x":"Suggested"}]}}"#;

    fn run<F: Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    struct FakePage {
        /// Match counts per selector.
        counts: Mutex<Vec<Vec<i64>>>,
        log: Mutex<Vec<String>>,
        /// The user switched to another page: this one no longer carries the job's token.
        moved: std::sync::atomic::AtomicBool,
    }

    impl FakePage {
        fn new(counts: Vec<Vec<i64>>) -> Self {
            Self {
                counts: Mutex::new(counts),
                log: Mutex::new(Vec::new()),
                moved: std::sync::atomic::AtomicBool::new(false),
            }
        }
        fn log(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }
    }

    impl Page for FakePage {
        fn evaluate(&self, script: String) -> Result<String> {
            self.log.lock().unwrap().push(script.clone());
            if script == snapshot::SNAPSHOT_SCRIPT {
                Ok(SNAPSHOT.to_owned())
            } else if script.starts_with(PAGE_CHECK_PREFIX) {
                let moved = self.moved.load(std::sync::atomic::Ordering::SeqCst);
                Ok((!moved).to_string())
            } else if script.starts_with(snapshot::COUNT_SCRIPT_PREFIX) {
                let mut counts = self.counts.lock().unwrap();
                Ok(serde_json::to_string(&counts.remove(0)).unwrap())
            } else {
                Ok("null".to_owned())
            }
        }
    }

    struct FakeModel(Mutex<Vec<String>>, Mutex<Vec<String>>);

    impl FakeModel {
        fn new(answers: &[&str]) -> Self {
            Self(
                Mutex::new(answers.iter().map(|a| (*a).to_owned()).collect()),
                Mutex::new(Vec::new()),
            )
        }
        fn prompts(&self) -> Vec<String> {
            self.1.lock().unwrap().clone()
        }
    }

    impl Model for FakeModel {
        async fn complete(&self, prompt: &Prompt, _schema: &Value) -> Result<String> {
            self.1.lock().unwrap().push(prompt.user.clone());
            Ok(self.0.lock().unwrap().remove(0))
        }
    }

    fn new_option(selector: &str) -> String {
        json!({"kind":"newOption","summary":"Hides the promo","optionId":null,
          "label":"Hide promo","description":"The promo box.","group":"content",
          "rules":[{"label":"Promo box","selector":selector}]})
        .to_string()
    }

    fn provider() -> ProviderConfig {
        ProviderConfig {
            id: Uuid::new_v4(),
            name: "Test".into(),
            kind: ProviderKind::OpenAiCompatible,
            base_url: "https://example.test/v1".into(),
            model: Some("m".into()),
        }
    }

    fn input(base: Option<Recipe>) -> PrepareInput<impl FnOnce(&str, &str) -> RecipeContext> {
        PrepareInput {
            request: "hide the promo".into(),
            provider: provider(),
            earlier: Vec::new(),
            context: move |_: &str, _: &str| RecipeContext {
                base,
                option_states: BTreeMap::new(),
            },
        }
    }

    fn youtube() -> Recipe {
        official_recipes()
            .into_iter()
            .find(|r| r.id == "market.official.youtube")
            .unwrap()
    }

    #[test]
    fn prepare_sends_nothing_and_previews_the_exact_prompt() {
        run(async {
            let agent = Agent::default();
            let page = FakePage::new(vec![]);
            let prepared = prepare(&agent, &page, input(None)).unwrap();
            assert!(prepared.payload.contains("hide the promo"));
            assert!(prepared.token_estimate > 0);
            // Reading the page, then naming the job on it; nothing is previewed or changed.
            let log = page.log();
            assert_eq!(log.len(), 2);
            assert_eq!(log[0], snapshot::SNAPSHOT_SCRIPT);
            assert!(log[1].starts_with(PAGE_MARK_PREFIX));
            assert!(agent.get(prepared.id).is_ok());
        });
    }

    #[test]
    fn a_good_answer_is_previewed_counted_and_accepted_as_a_custom_recipe() {
        run(async {
            let agent = Agent::default();
            let page = FakePage::new(vec![vec![3]]);
            let prepared = prepare(&agent, &page, input(None)).unwrap();
            let model = FakeModel::new(&[&new_option("#promo")]);
            let proposal = send(&agent, &page, &model, &|_| {}, prepared.id)
                .await
                .unwrap();
            assert_eq!(proposal.kind, ProposalKind::NewOption);
            assert_eq!(proposal.recipe_id, "custom.example.org");
            assert_eq!(proposal.rules[0].matches, 3);
            assert_eq!(proposal.unmatched, 0);
            assert!(
                page.log()
                    .iter()
                    .any(|s| s.contains("#promo{display:none!important;}"))
            );

            let Accepted::SaveRecipe(recipe) = accept(&agent, &page, prepared.id).unwrap() else {
                panic!("expected a recipe");
            };
            assert_eq!(recipe.id, "custom.example.org");
            assert_eq!(recipe.options.len(), 1);
            assert!(recipe.options[0].enabled_by_default);
            assert!(agent.get(prepared.id).is_err(), "the job is gone");
        });
    }

    #[test]
    fn rules_that_match_nothing_are_repaired_with_feedback_up_to_the_cap() {
        run(async {
            let agent = Agent::default();
            let page = FakePage::new(vec![vec![0], vec![2]]);
            let prepared = prepare(&agent, &page, input(None)).unwrap();
            let model = FakeModel::new(&[&new_option("#nope"), &new_option("#promo")]);
            let proposal = send(&agent, &page, &model, &|_| {}, prepared.id)
                .await
                .unwrap();
            assert_eq!(proposal.rules[0].selector, "#promo");
            assert_eq!(proposal.unmatched, 0);
            let prompts = model.prompts();
            assert_eq!(prompts.len(), 2);
            assert!(prompts[1].contains("#nope"), "the failure is fed back");

            let agent = Agent::default();
            let page = FakePage::new(vec![vec![0], vec![0], vec![0]]);
            let prepared = prepare(&agent, &page, input(None)).unwrap();
            let model = FakeModel::new(&[&new_option("#a"), &new_option("#b"), &new_option("#c")]);
            let proposal = send(&agent, &page, &model, &|_| {}, prepared.id)
                .await
                .unwrap();
            assert_eq!(
                model.prompts().len(),
                3,
                "first answer plus two repairs, no more"
            );
            assert_eq!(proposal.unmatched, 1);
        });
    }

    #[test]
    fn every_step_is_reported_in_order_including_the_repair() {
        run(async {
            let agent = Agent::default();
            let page = FakePage::new(vec![vec![0], vec![2]]);
            let prepared = prepare(&agent, &page, input(None)).unwrap();
            let model = FakeModel::new(&[&new_option("#nope"), &new_option("#promo")]);
            let steps = Mutex::new(Vec::new());
            send(
                &agent,
                &page,
                &model,
                &|step| steps.lock().unwrap().push(step),
                prepared.id,
            )
            .await
            .unwrap();
            let seen: Vec<(StepKind, StepStatus, u8)> = steps
                .lock()
                .unwrap()
                .iter()
                .map(|step| (step.kind, step.status, step.round))
                .collect();
            use StepKind::{AskModel, CheckAnswer, CountMatches, PreviewOnPage, Repair};
            use StepStatus::{Done, Running};
            assert_eq!(
                seen,
                vec![
                    (AskModel, Running, 0),
                    (AskModel, Done, 0),
                    (CheckAnswer, Done, 0),
                    (PreviewOnPage, Done, 0),
                    (CountMatches, Done, 0),
                    (Repair, Done, 1),
                    (AskModel, Running, 1),
                    (AskModel, Done, 1),
                    (CheckAnswer, Done, 1),
                    (PreviewOnPage, Done, 1),
                    (CountMatches, Done, 1),
                ]
            );
            let steps = steps.lock().unwrap();
            assert_eq!(steps[4].matched, Some(0));
            assert_eq!(steps[4].total, Some(1));
            assert_eq!(steps[5].total, Some(1), "one rule matched nothing");
            assert_eq!(steps[10].matched, Some(1));
        });
    }

    #[test]
    fn a_failed_model_call_is_reported_as_a_failed_step() {
        struct Down;
        impl Model for Down {
            async fn complete(&self, _: &Prompt, _: &Value) -> Result<String> {
                Err(Error::Connection("down".into()))
            }
        }
        run(async {
            let agent = Agent::default();
            let page = FakePage::new(vec![]);
            let prepared = prepare(&agent, &page, input(None)).unwrap();
            let steps = Mutex::new(Vec::new());
            let result = send(
                &agent,
                &page,
                &Down,
                &|step| steps.lock().unwrap().push(step),
                prepared.id,
            )
            .await;
            assert!(result.is_err());
            let steps = steps.lock().unwrap();
            assert_eq!(steps.last().unwrap().status, StepStatus::Failed);
            assert_eq!(steps.last().unwrap().kind, StepKind::AskModel);
        });
    }

    #[test]
    fn an_invalid_answer_gets_one_more_chance_and_then_a_fixed_error() {
        run(async {
            let agent = Agent::default();
            let page = FakePage::new(vec![vec![1]]);
            let prepared = prepare(&agent, &page, input(None)).unwrap();
            let model = FakeModel::new(&["not json", &new_option("#promo")]);
            assert!(
                send(&agent, &page, &model, &|_| {}, prepared.id)
                    .await
                    .is_ok()
            );

            let agent = Agent::default();
            let prepared = prepare(&agent, &page, input(None)).unwrap();
            let model = FakeModel::new(&["x", "y", "z"]);
            let error = send(&agent, &page, &model, &|_| {}, prepared.id)
                .await
                .unwrap_err();
            assert_eq!(error.to_string(), MSG_BAD_ANSWER);
        });
    }

    #[test]
    fn an_existing_option_is_counted_and_accepting_only_turns_it_on() {
        run(async {
            let base = youtube();
            let option = base.options[0].id.clone();
            let agent = Agent::default();
            let rule_count = base
                .rules
                .iter()
                .filter(|r| r.option() == Some(option.as_str()))
                .count();
            let page = FakePage::new(vec![vec![1; rule_count]]);
            let prepared = prepare(&agent, &page, input(Some(base))).unwrap();
            let answer =
                json!({"kind":"existingOption","summary":"Already there","optionId":option,
          "label":null,"description":null,"group":null,"rules":null})
                .to_string();
            let model = FakeModel::new(&[&answer]);
            let proposal = send(&agent, &page, &model, &|_| {}, prepared.id)
                .await
                .unwrap();
            assert_eq!(proposal.kind, ProposalKind::ExistingOption);
            assert_eq!(proposal.option.id.as_deref(), Some(option.as_str()));
            match accept(&agent, &page, prepared.id).unwrap() {
                Accepted::EnableOption {
                    recipe_id,
                    option_id,
                } => {
                    assert_eq!(recipe_id, "market.official.youtube");
                    assert_eq!(option_id, option);
                }
                Accepted::SaveRecipe(_) => panic!("nothing to save"),
            }
        });
    }

    #[test]
    fn rejecting_clears_the_preview_and_the_job_and_empty_requests_are_refused() {
        run(async {
            let agent = Agent::default();
            let page = FakePage::new(vec![]);
            let prepared = prepare(&agent, &page, input(None)).unwrap();
            reject(&agent, &page, prepared.id);
            assert!(agent.get(prepared.id).is_err());
            assert!(
                page.log()
                    .last()
                    .unwrap()
                    .contains(snapshot::PREVIEW_STYLE_ID)
            );
            let mut empty = input(None);
            empty.request = "   ".into();
            assert!(prepare(&agent, &page, empty).is_err());
        });
    }
    #[test]
    fn a_job_refuses_to_touch_a_page_it_was_not_prepared_on() {
        run(async {
            let agent = Agent::default();
            let page = FakePage::new(vec![]);
            let prepared = prepare(&agent, &page, input(None)).unwrap();
            // The user switched to another site while the request waited.
            page.moved.store(true, std::sync::atomic::Ordering::SeqCst);
            let before = page.log().len();
            let model = FakeModel::new(&[&new_option("div")]);
            let result = send(&agent, &page, &model, &|_| {}, prepared.id).await;
            assert!(matches!(&result, Err(Error::Connection(m)) if m == MSG_PAGE_CHANGED));
            // Only the page check ran: nothing was previewed, counted or read again.
            let after = page.log();
            assert_eq!(after.len(), before + 1);
            assert!(after[before].starts_with(PAGE_CHECK_PREFIX));
        });
    }

    #[test]
    fn cancelling_while_the_model_answers_stops_before_the_page_and_further_calls() {
        struct CancelsItself<'a> {
            agent: &'a Agent,
            id: Mutex<Option<Uuid>>,
            calls: Mutex<usize>,
        }
        impl Model for CancelsItself<'_> {
            async fn complete(&self, _: &Prompt, _: &Value) -> Result<String> {
                *self.calls.lock().unwrap() += 1;
                if let Some(id) = *self.id.lock().unwrap() {
                    self.agent.discard(id);
                }
                Ok(new_option("div"))
            }
        }
        run(async {
            let agent = Agent::default();
            let page = FakePage::new(vec![vec![0]; 3]);
            let prepared = prepare(&agent, &page, input(None)).unwrap();
            let model = CancelsItself {
                agent: &agent,
                id: Mutex::new(Some(prepared.id)),
                calls: Mutex::new(0),
            };
            let before = page.log().len();
            let result = send(&agent, &page, &model, &|_| {}, prepared.id).await;
            assert!(matches!(&result, Err(Error::Connection(m)) if m == MSG_CANCELLED));
            assert_eq!(*model.calls.lock().unwrap(), 1);
            assert_eq!(page.log().len(), before);
        });
    }

    fn script_option(code: &str) -> String {
        json!({"kind":"newOption","summary":"Posts nothing; logs the title.","optionId":null,
          "label":"Log the title","description":"Runs a script.","group":"content",
          "rules":[{"label":"Title","selector":null,"declarations":null,"script":code}]})
        .to_string()
    }

    #[test]
    fn a_script_proposal_shows_code_and_powers_and_runs_nothing_before_accept() {
        let code = "const r = fetch(\"https://example.org/x\");\nreturn r;";
        run(async {
            let agent = Agent::default();
            let page = FakePage::new(vec![]);
            let prepared = prepare(&agent, &page, input(None)).unwrap();
            let model = FakeModel::new(&[&script_option(code)]);
            let proposal = send(&agent, &page, &model, &|_| {}, prepared.id)
                .await
                .unwrap();
            let rule = &proposal.rules[0];
            assert_eq!(rule.kind, ProposalRuleKind::Script);
            assert_eq!(rule.code.as_deref(), Some(code));
            assert_eq!(rule.selector, "");
            assert_eq!(proposal.unmatched, 0, "a script is not counted");
            assert!(proposal.runs_code);
            let scanned = script_policy::scan(code);
            assert_eq!(rule.powers.len(), scanned.len());
            assert_eq!(proposal.publishable, scanned.is_empty());
            assert!(
                page.log().iter().all(|script| !script.contains("fetch(")),
                "the script text never reaches the page before accept"
            );

            let Accepted::SaveRecipe(recipe) = accept(&agent, &page, prepared.id).unwrap() else {
                panic!("expected a recipe");
            };
            assert!(recipe.rules.iter().any(|rule| matches!(
                rule,
                Rule::Script { code: saved, option: Some(option), .. }
                    if saved == code && option == "log-the-title"
            )));
            assert_eq!(recipe.origin, crate::recipes::Origin::Ai);
            let json = serde_json::to_string(&recipe).unwrap();
            assert_eq!(Recipe::parse(&json).unwrap(), *recipe);
            assert!(
                page.log().iter().all(|script| !script.contains("fetch(")),
                "not even accept runs it: the page script does, on the next load"
            );
        });
    }

    #[test]
    fn a_mixed_proposal_keeps_order_and_counts_only_its_style_rules() {
        run(async {
            let agent = Agent::default();
            let page = FakePage::new(vec![vec![0], vec![0], vec![0]]);
            let prepared = prepare(&agent, &page, input(None)).unwrap();
            let answer = json!({"kind":"newOption","summary":"s","optionId":null,
            "label":"Mixed","description":"d","group":"content",
            "rules":[
              {"label":"Script","selector":null,"declarations":null,"script":"return 1;"},
              {"label":"Promo","selector":"#nope","declarations":null,"script":null}
            ]})
            .to_string();
            let model = FakeModel::new(&[&answer, &answer, &answer]);
            let proposal = send(&agent, &page, &model, &|_| {}, prepared.id)
                .await
                .unwrap();
            assert_eq!(proposal.rules.len(), 2);
            assert_eq!(proposal.rules[0].kind, ProposalRuleKind::Script);
            assert_eq!(proposal.rules[1].kind, ProposalRuleKind::Style);
            assert_eq!(proposal.unmatched, 1);
            assert!(proposal.runs_code);
        });
    }

    #[test]
    fn a_script_that_breaks_out_of_its_wrapper_is_not_proposed() {
        run(async {
            let agent = Agent::default();
            let page = FakePage::new(vec![]);
            let prepared = prepare(&agent, &page, input(None)).unwrap();
            let evil = script_option("}); x(); (function(){");
            let model = FakeModel::new(&[&evil, &evil, &evil]);
            let result = send(&agent, &page, &model, &|_| {}, prepared.id).await;
            assert!(result.is_err());
            assert!(page.log().iter().all(|script| !script.contains("x();")));
        });
    }
}
