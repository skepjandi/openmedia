//! The request flow: snapshot the page, ask the model, preview its answer on the page, check what
//! it matched, repair, and on accept save it. Everything that touches the page or the provider
//! goes through [`Page`] and [`Model`], so the flow is tested with fakes.

use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    sync::{Mutex, PoisonError},
    time::Instant,
};

use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use super::{
    ProviderConfig,
    patch::{self, Patch},
    prompt::{self, Prompt, PromptInput, RepairNote, RuleFailure},
    redact,
    snapshot::{self, Snapshot},
};
use crate::error::{Error, Result};
use crate::recipes::{OptionGroup, Recipe, Rule};

const MAX_REQUEST_CHARS: usize = 500;
const MAX_JOBS: usize = 8;
/// Rounds after the first answer that may repair rules which matched nothing.
const MAX_REPAIRS: u8 = 2;

const MSG_BAD_ANSWER: &str = "The model's answer was not in the expected form.";
const MSG_NO_JOB: &str = "That request has expired. Ask again.";
const MSG_BAD_PAGE: &str = "The page could not be read.";

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
    pub payload: String,
    pub token_estimate: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProposalKind {
    ExistingOption,
    NewOption,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalOption {
    pub id: Option<String>,
    pub label: String,
    pub description: String,
    pub group: OptionGroup,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalRule {
    pub label: String,
    pub selector: String,
    pub matches: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: Uuid,
    pub kind: ProposalKind,
    pub summary: String,
    pub recipe_id: String,
    pub recipe_name: String,
    pub forked: bool,
    pub option: ProposalOption,
    pub rules: Vec<ProposalRule>,
    /// Rules that matched no element on the page.
    pub unmatched: usize,
}

/// Everything about one request that has to outlive a command call.
#[derive(Clone)]
pub struct Job {
    pub request: String,
    pub domain: String,
    pub provider: ProviderConfig,
    /// The recipe that already covers the page, if any.
    pub base: Option<Recipe>,
    /// Whether `base` is a bundled recipe (so saving makes a fork).
    pub base_is_bundled: bool,
    pub option_states: BTreeMap<String, bool>,
    pub snapshot: Snapshot,
    pub patch: Option<Patch>,
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
    pub base_is_bundled: bool,
    pub option_states: BTreeMap<String, bool>,
}

/// What `ai_prepare` needs to know that only the commands can look up.
pub struct PrepareInput<F: FnOnce(&str, &str) -> RecipeContext> {
    pub request: String,
    pub provider: ProviderConfig,
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
    let job = Job {
        request,
        domain,
        provider: input.provider,
        base: context.base,
        base_is_bundled: context.base_is_bundled,
        option_states: context.option_states,
        snapshot,
        patch: None,
        created: Instant::now(),
    };
    let prompt = build_prompt(&job, &job.snapshot, None);
    let prepared = |id| PreparedRequest {
        id,
        provider_name: job.provider.name.clone(),
        model: job.provider.model.clone(),
        payload: prompt::payload_preview(&prompt),
        token_estimate: prompt::estimate_tokens(&prompt),
    };
    let id = agent.insert(job.clone());
    Ok(prepared(id))
}

/// The selectors the page is asked to count, and the css that previews them.
fn selectors_and_css(patch: &Patch, base: Option<&Recipe>) -> (Vec<(String, String)>, String) {
    match (patch, base) {
        (Patch::NewOption { rules, .. }, _) => (
            rules
                .iter()
                .map(|rule| (rule.label.clone(), rule.selector.clone()))
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
    let json = page.evaluate(snapshot::count_script(selectors))?;
    let counts: Vec<i64> =
        serde_json::from_str(&json).map_err(|_| Error::Connection(MSG_BAD_PAGE.to_owned()))?;
    if counts.len() == selectors.len() {
        Ok(counts)
    } else {
        Err(Error::Connection(MSG_BAD_PAGE.to_owned()))
    }
}

fn proposal_for(id: Uuid, job: &Job, patch: &Patch, rules: Vec<ProposalRule>) -> Proposal {
    let unmatched = rules.iter().filter(|rule| rule.matches <= 0).count();
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
    Proposal {
        id,
        kind,
        summary: patch.summary().to_owned(),
        recipe_id: job
            .base
            .as_ref()
            .map_or_else(|| format!("custom.{}", job.domain), |r| r.id.clone()),
        recipe_name: job
            .base
            .as_ref()
            .map_or_else(|| job.domain.clone(), |r| r.name.clone()),
        forked: job.base_is_bundled,
        option,
        rules,
        unmatched,
    }
}

/// Sends the prepared request, previews the answer on the page, and repairs rules that matched
/// nothing (at most [`MAX_REPAIRS`] more rounds). The preview stays on the page until the user
/// accepts or rejects.
pub async fn send(
    agent: &Agent,
    page: &impl Page,
    model: &impl Model,
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
        let prompt = build_prompt(&job, &snapshot, repair);
        let answer = model.complete(&prompt, &schema).await?;

        let patch = match patch::parse_patch(&answer, job.base.as_ref()) {
            Ok(patch) => patch,
            Err(error) if round < MAX_REPAIRS => {
                validation_error = Some(error.to_string());
                previous = Some(answer);
                failures.clear();
                continue;
            }
            Err(_) => return Err(Error::Connection(MSG_BAD_ANSWER.to_owned())),
        };

        let (rules, css) = selectors_and_css(&patch, job.base.as_ref());
        let selectors: Vec<String> = rules.iter().map(|(_, selector)| selector.clone()).collect();
        page.evaluate(snapshot::preview_script(&css))?;
        let counts = counts_of(page, &selectors)?;
        let failed: Vec<(String, String, i64)> = rules
            .iter()
            .zip(&counts)
            .filter(|(_, count)| **count <= 0)
            .map(|((label, selector), count)| (label.clone(), selector.clone(), *count))
            .collect();

        if failed.is_empty() || round == MAX_REPAIRS {
            let shown = rules
                .into_iter()
                .zip(counts)
                .map(|((label, selector), matches)| ProposalRule {
                    label,
                    selector,
                    matches,
                })
                .collect();
            let proposal = proposal_for(id, &job, &patch, shown);
            agent.set_patch(id, patch);
            return Ok(proposal);
        }

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
    /// Save this recipe (a fork of a bundled one, or a new custom one).
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
    use crate::recipes::bundled;

    const SNAPSHOT: &str = r#"{"v":1,"host":"www.example.org","path":"/","w":390,"vw":"phone","sl":false,"tr":false,"root":{"t":"body","k":[{"t":"div","x":"Suggested"}]}}"#;

    fn run<F: Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    struct FakePage {
        /// Match counts per selector.
        counts: Mutex<Vec<Vec<i64>>>,
        log: Mutex<Vec<String>>,
    }

    impl FakePage {
        fn new(counts: Vec<Vec<i64>>) -> Self {
            Self {
                counts: Mutex::new(counts),
                log: Mutex::new(Vec::new()),
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

    fn input(
        base: Option<Recipe>,
        bundled: bool,
    ) -> PrepareInput<impl FnOnce(&str, &str) -> RecipeContext> {
        PrepareInput {
            request: "hide the promo".into(),
            provider: provider(),
            context: move |_: &str, _: &str| RecipeContext {
                base,
                base_is_bundled: bundled,
                option_states: BTreeMap::new(),
            },
        }
    }

    fn youtube() -> Recipe {
        bundled()
            .unwrap()
            .into_iter()
            .find(|r| r.id == "youtube.default")
            .unwrap()
    }

    #[test]
    fn prepare_sends_nothing_and_previews_the_exact_prompt() {
        run(async {
            let agent = Agent::default();
            let page = FakePage::new(vec![]);
            let prepared = prepare(&agent, &page, input(None, false)).unwrap();
            assert!(prepared.payload.contains("hide the promo"));
            assert!(prepared.token_estimate > 0);
            assert_eq!(page.log(), vec![snapshot::SNAPSHOT_SCRIPT.to_owned()]);
            assert!(agent.get(prepared.id).is_ok());
        });
    }

    #[test]
    fn a_good_answer_is_previewed_counted_and_accepted_as_a_custom_recipe() {
        run(async {
            let agent = Agent::default();
            let page = FakePage::new(vec![vec![3]]);
            let prepared = prepare(&agent, &page, input(None, false)).unwrap();
            let model = FakeModel::new(&[&new_option("#promo")]);
            let proposal = send(&agent, &page, &model, prepared.id).await.unwrap();
            assert_eq!(proposal.kind, ProposalKind::NewOption);
            assert_eq!(proposal.recipe_id, "custom.example.org");
            assert!(!proposal.forked);
            assert_eq!(proposal.rules[0].matches, 3);
            assert_eq!(proposal.unmatched, 0);
            assert!(
                page.log()
                    .iter()
                    .any(|s| s.contains("#promo{display:none!important}"))
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
            let prepared = prepare(&agent, &page, input(None, false)).unwrap();
            let model = FakeModel::new(&[&new_option("#nope"), &new_option("#promo")]);
            let proposal = send(&agent, &page, &model, prepared.id).await.unwrap();
            assert_eq!(proposal.rules[0].selector, "#promo");
            assert_eq!(proposal.unmatched, 0);
            let prompts = model.prompts();
            assert_eq!(prompts.len(), 2);
            assert!(prompts[1].contains("#nope"), "the failure is fed back");

            let agent = Agent::default();
            let page = FakePage::new(vec![vec![0], vec![0], vec![0]]);
            let prepared = prepare(&agent, &page, input(None, false)).unwrap();
            let model = FakeModel::new(&[&new_option("#a"), &new_option("#b"), &new_option("#c")]);
            let proposal = send(&agent, &page, &model, prepared.id).await.unwrap();
            assert_eq!(
                model.prompts().len(),
                3,
                "first answer plus two repairs, no more"
            );
            assert_eq!(proposal.unmatched, 1);
        });
    }

    #[test]
    fn an_invalid_answer_gets_one_more_chance_and_then_a_fixed_error() {
        run(async {
            let agent = Agent::default();
            let page = FakePage::new(vec![vec![1]]);
            let prepared = prepare(&agent, &page, input(None, false)).unwrap();
            let model = FakeModel::new(&["not json", &new_option("#promo")]);
            assert!(send(&agent, &page, &model, prepared.id).await.is_ok());

            let agent = Agent::default();
            let prepared = prepare(&agent, &page, input(None, false)).unwrap();
            let model = FakeModel::new(&["x", "y", "z"]);
            let error = send(&agent, &page, &model, prepared.id).await.unwrap_err();
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
            let prepared = prepare(&agent, &page, input(Some(base), true)).unwrap();
            let answer =
                json!({"kind":"existingOption","summary":"Already there","optionId":option,
          "label":null,"description":null,"group":null,"rules":null})
                .to_string();
            let model = FakeModel::new(&[&answer]);
            let proposal = send(&agent, &page, &model, prepared.id).await.unwrap();
            assert_eq!(proposal.kind, ProposalKind::ExistingOption);
            assert!(proposal.forked);
            assert_eq!(proposal.option.id.as_deref(), Some(option.as_str()));
            match accept(&agent, &page, prepared.id).unwrap() {
                Accepted::EnableOption {
                    recipe_id,
                    option_id,
                } => {
                    assert_eq!(recipe_id, "youtube.default");
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
            let prepared = prepare(&agent, &page, input(None, false)).unwrap();
            reject(&agent, &page, prepared.id);
            assert!(agent.get(prepared.id).is_err());
            assert!(
                page.log()
                    .last()
                    .unwrap()
                    .contains(snapshot::PREVIEW_STYLE_ID)
            );
            let mut empty = input(None, false);
            empty.request = "   ".into();
            assert!(prepare(&agent, &page, empty).is_err());
        });
    }
}
