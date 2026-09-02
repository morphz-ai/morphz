//! Canonical native S-expression codec for Morphz's persistent cognitive AST.
//!
//! This is the only serialization boundary between the Context domain and a
//! ContextStore backend. SQLite and PostgreSQL persist the exact returned
//! bytes; neither backend is allowed to introduce JSON, Base64, or a second
//! domain schema.

use crate::context_state::{
    ContextFrame, ContextMutationClocks, ContextRelation, FrameIdentityProvenance,
    FrameProvenanceState, FrameRetirement, MindCheckpoint, MindState,
};
use crate::context_store::{ContextCollection, ContextNodeValue};
use crate::sexpr::{self, SExpr};
use chrono::{DateTime, SecondsFormat, Utc};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const FRAMES_NODE_ID: &str = "morphz/frames";
const RELATIONS_NODE_ID: &str = "morphz/relations";
const RETIRED_NODE_ID: &str = "morphz/retired";
const RETIRING_NODE_ID: &str = "morphz/retiring";
const PROTECTED_NODE_ID: &str = "morphz/protected";
const CHECKPOINTS_NODE_ID: &str = "morphz/checkpoints";
const CLOCKS_NODE_ID: &str = "morphz/clocks";
const AGENT_MIND_DOMAIN: &str = "agent_mind";

const STATE_ROOTS: [(i64, &str); 7] = [
    (10, FRAMES_NODE_ID),
    (20, RELATIONS_NODE_ID),
    (30, RETIRED_NODE_ID),
    (40, RETIRING_NODE_ID),
    (50, PROTECTED_NODE_ID),
    (60, CHECKPOINTS_NODE_ID),
    (70, CLOCKS_NODE_ID),
];

/// Runtime head metadata stored beside the persistent cognitive subtree.
///
/// This is operational fencing metadata, not a model-visible Mind Frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ContextAstHead {
    pub revision: u64,
    pub state_hash: String,
    pub head_event_id: Option<String>,
    pub updated_at: DateTime<Utc>,
}

pub(crate) fn encode_context_head(head: &ContextAstHead) -> Result<String, String> {
    canonical_string(record(
        "projection-meta",
        vec![
            field("revision", number(head.revision)),
            field("state-hash", atom(&head.state_hash)),
            field(
                "head-event-id",
                optional_atom(head.head_event_id.as_deref()),
            ),
            field(
                "updated-at",
                atom(head.updated_at.to_rfc3339_opts(SecondsFormat::Nanos, true)),
            ),
        ],
    ))
}

pub(crate) fn decode_context_head(body: &str) -> Result<ContextAstHead, String> {
    let expression = parse_canonical(body)?;
    let fields = exact_record(&expression, "projection-meta", 4)?;
    let revision = decode_number(exact_field(fields, 0, "revision")?, "revision")?;
    let state_hash = decode_atom(exact_field(fields, 1, "state-hash")?, "state-hash")?;
    let head_event_id =
        decode_optional_atom(exact_field(fields, 2, "head-event-id")?, "head-event-id")?;
    let updated_at = DateTime::parse_from_rfc3339(&decode_atom(
        exact_field(fields, 3, "updated-at")?,
        "updated-at",
    )?)
    .map_err(|error| format!("invalid projection-meta updated-at: {error}"))?
    .with_timezone(&Utc);
    let decoded = ContextAstHead {
        revision,
        state_hash,
        head_event_id,
        updated_at,
    };
    ensure_round_trip(body, encode_context_head(&decoded)?)?;
    Ok(decoded)
}

pub(crate) fn encode_context_value(value: &ContextNodeValue) -> Result<String, String> {
    canonical_string(encode_value(value)?)
}

pub(crate) fn decode_context_value(
    body: &str,
    expected_collection: ContextCollection,
) -> Result<ContextNodeValue, String> {
    let expression = parse_canonical(body)?;
    let value = match expected_collection {
        ContextCollection::Frame => ContextNodeValue::Frame(decode_frame(&expression)?),
        ContextCollection::Relation => ContextNodeValue::Relation(decode_relation(&expression)?),
        ContextCollection::Retired => {
            ContextNodeValue::Retired(decode_identity_entry(&expression, "retired-entry")?)
        }
        ContextCollection::Retiring => ContextNodeValue::Retiring(decode_retirement(&expression)?),
        ContextCollection::Protected => {
            ContextNodeValue::Protected(decode_identity_entry(&expression, "protected-entry")?)
        }
        ContextCollection::Checkpoint => {
            ContextNodeValue::Checkpoint(decode_checkpoint(&expression)?)
        }
        ContextCollection::MutationClocks => {
            ContextNodeValue::MutationClocks(decode_mutation_clocks(&expression)?)
        }
    };
    ensure_round_trip(body, encode_context_value(&value)?)?;
    Ok(value)
}

/// Native ordered commitment for one authoritative Mind state.
///
/// This is deliberately derived from the exact canonical S-expression leaves
/// and collection tree used by ContextDB. Operational metadata such as the
/// current Event identity and wall-clock update time is excluded, so the same
/// cognitive state has one commitment on every backend. The hierarchy lets a
/// Store verify a bounded mutation from changed leaves plus persisted sibling
/// hashes instead of serializing the complete Mind as JSON.
pub(crate) type NativeCollectionCommitment = (i64, String, String);
pub(crate) type NativeMindStateCommitmentParts = (String, Vec<NativeCollectionCommitment>);

pub(crate) fn native_mind_state_commitment_parts(
    state: &MindState,
) -> Result<NativeMindStateCommitmentParts, String> {
    let mut roots = Vec::with_capacity(STATE_ROOTS.len());

    roots.push(collection_subtree_hash(
        ContextCollection::Frame,
        FRAMES_NODE_ID,
        "frames",
        state
            .frames
            .iter()
            .enumerate()
            .map(|(index, frame)| {
                ordered_value_descriptor(index, ContextNodeValue::Frame(frame.clone()))
            })
            .collect::<Result<Vec<_>, _>>()?,
    )?);
    roots.push(collection_subtree_hash(
        ContextCollection::Relation,
        RELATIONS_NODE_ID,
        "relations",
        state
            .relations
            .iter()
            .enumerate()
            .map(|(index, relation)| {
                ordered_value_descriptor(index, ContextNodeValue::Relation(relation.clone()))
            })
            .collect::<Result<Vec<_>, _>>()?,
    )?);
    roots.push(collection_subtree_hash(
        ContextCollection::Retired,
        RETIRED_NODE_ID,
        "retired",
        state
            .retired
            .iter()
            .map(|id| unordered_value_descriptor(ContextNodeValue::Retired(id.clone())))
            .collect::<Result<Vec<_>, _>>()?,
    )?);
    roots.push(collection_subtree_hash(
        ContextCollection::Retiring,
        RETIRING_NODE_ID,
        "retiring",
        state
            .retiring
            .values()
            .cloned()
            .map(ContextNodeValue::Retiring)
            .map(unordered_value_descriptor)
            .collect::<Result<Vec<_>, _>>()?,
    )?);
    roots.push(collection_subtree_hash(
        ContextCollection::Protected,
        PROTECTED_NODE_ID,
        "protected",
        state
            .protected
            .iter()
            .map(|id| unordered_value_descriptor(ContextNodeValue::Protected(id.clone())))
            .collect::<Result<Vec<_>, _>>()?,
    )?);
    roots.push(collection_subtree_hash(
        ContextCollection::Checkpoint,
        CHECKPOINTS_NODE_ID,
        "checkpoints",
        state
            .checkpoints
            .iter()
            .enumerate()
            .map(|(index, checkpoint)| {
                ordered_value_descriptor(index, ContextNodeValue::Checkpoint(checkpoint.clone()))
            })
            .collect::<Result<Vec<_>, _>>()?,
    )?);

    let clocks = ContextNodeValue::MutationClocks(state.mutation_clocks.clone());
    roots.push((
        70,
        CLOCKS_NODE_ID.to_string(),
        hash_context_node(
            CLOCKS_NODE_ID,
            AGENT_MIND_DOMAIN,
            &encode_context_value(&clocks)?,
            &[],
        ),
    ));

    let state_hash = native_mind_state_hash_from_roots(state.version, &roots)?;
    Ok((state_hash, roots))
}

#[cfg(test)]
pub(crate) fn native_mind_state_hash(state: &MindState) -> Result<String, String> {
    native_mind_state_commitment_parts(state).map(|(state_hash, _)| state_hash)
}

/// Computes the same Mind commitment from already materialized top-level
/// subtree hashes. This is the incremental Store-side verification boundary.
pub(crate) fn native_mind_state_hash_from_roots(
    revision: u64,
    roots: &[(i64, String, String)],
) -> Result<String, String> {
    let mut canonical = roots.to_vec();
    canonical.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    if canonical.len() != STATE_ROOTS.len()
        || canonical.iter().zip(STATE_ROOTS).any(
            |((actual_order, actual_id, _), (expected_order, expected_id))| {
                *actual_order != expected_order || actual_id != expected_id
            },
        )
    {
        return Err("Mind state roots do not match the native Context schema".to_string());
    }

    let mut hasher = Sha256::new();
    hasher.update(b"morphz-context-state-v1\0");
    hasher.update(revision.to_be_bytes());
    for (order, node_id, subtree_hash) in canonical {
        hasher.update(b"\0root\0");
        hasher.update(order.to_be_bytes());
        hash_len_prefixed(&mut hasher, node_id.as_bytes());
        hash_len_prefixed(&mut hasher, subtree_hash.as_bytes());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Shared physical Node commitment used by ContextDB and the native Mind
/// commitment. Keeping it here prevents SQLite, PostgreSQL and the domain
/// hasher from drifting into subtly different encodings.
pub(crate) fn hash_context_node(
    node_id: &str,
    owner_domain: &str,
    body_sexpr: &str,
    children: &[(i64, String, String)],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"morphz-contextdb-node-v1\0");
    hasher.update(node_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(owner_domain.as_bytes());
    hasher.update(b"\0");
    hasher.update(body_sexpr.as_bytes());
    for (order_key, child_id, child_hash) in children {
        hasher.update(b"\0child\0");
        hasher.update(order_key.to_be_bytes());
        hasher.update(child_id.as_bytes());
        hasher.update(b"\0");
        hasher.update(child_hash.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn ordered_value_descriptor(
    index: usize,
    value: ContextNodeValue,
) -> Result<(i64, String, String), String> {
    let order =
        i64::try_from(index).map_err(|_| "Mind collection order exceeds i64".to_string())?;
    value_descriptor(order, value)
}

fn unordered_value_descriptor(value: ContextNodeValue) -> Result<(i64, String, String), String> {
    value_descriptor(0, value)
}

fn value_descriptor(order: i64, value: ContextNodeValue) -> Result<(i64, String, String), String> {
    let collection = value.collection();
    let node_id = native_node_id(collection, &value.logical_id())?;
    let body = encode_context_value(&value)?;
    let hash = hash_context_node(&node_id, AGENT_MIND_DOMAIN, &body, &[]);
    Ok((order, node_id, hash))
}

fn collection_subtree_hash(
    collection: ContextCollection,
    node_id: &str,
    kind: &str,
    mut children: Vec<(i64, String, String)>,
) -> Result<(i64, String, String), String> {
    children.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let order = match collection {
        ContextCollection::Frame => 10,
        ContextCollection::Relation => 20,
        ContextCollection::Retired => 30,
        ContextCollection::Retiring => 40,
        ContextCollection::Protected => 50,
        ContextCollection::Checkpoint => 60,
        ContextCollection::MutationClocks => {
            return Err("mutation_clocks is not a collection subtree".to_string());
        }
    };
    Ok((
        order,
        node_id.to_string(),
        hash_context_node(node_id, AGENT_MIND_DOMAIN, &format!("({kind})"), &children),
    ))
}

fn native_node_id(collection: ContextCollection, logical_id: &str) -> Result<String, String> {
    if collection == ContextCollection::MutationClocks {
        return (logical_id == "mutation-clocks")
            .then(|| CLOCKS_NODE_ID.to_string())
            .ok_or_else(|| "invalid mutation_clocks logical identity".to_string());
    }
    let kind = match collection {
        ContextCollection::Frame => "frame",
        ContextCollection::Relation => "relation",
        ContextCollection::Retired => "retired",
        ContextCollection::Retiring => "retiring",
        ContextCollection::Protected => "protected",
        ContextCollection::Checkpoint => "checkpoint",
        ContextCollection::MutationClocks => unreachable!(),
    };
    Ok(format!(
        "morphz/{kind}/{:x}",
        Sha256::digest(logical_id.as_bytes())
    ))
}

fn hash_len_prefixed(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

fn encode_value(value: &ContextNodeValue) -> Result<SExpr, String> {
    match value {
        ContextNodeValue::Frame(frame) => encode_frame(frame),
        ContextNodeValue::Relation(relation) => Ok(encode_relation(relation)),
        ContextNodeValue::Retired(id) => Ok(identity_entry("retired-entry", id)),
        ContextNodeValue::Retiring(retirement) => Ok(encode_retirement(retirement)),
        ContextNodeValue::Protected(id) => Ok(identity_entry("protected-entry", id)),
        ContextNodeValue::Checkpoint(checkpoint) => encode_checkpoint(checkpoint),
        ContextNodeValue::MutationClocks(clocks) => Ok(encode_mutation_clocks(clocks)),
    }
}

fn encode_frame(frame: &ContextFrame) -> Result<SExpr, String> {
    let body = parse_canonical(&frame.body).map_err(|error| {
        format!(
            "Frame '{}' has an invalid canonical body: {error}",
            frame.id
        )
    })?;
    Ok(record(
        "frame",
        vec![
            field("id", atom(&frame.id)),
            field("body", body),
            atom_sequence("sources", &frame.sources),
            field("provenance", encode_provenance(&frame.provenance)),
            field("revision", number(frame.revision)),
            field("created-version", number(frame.created_version)),
            field("updated-version", number(frame.updated_version)),
        ],
    ))
}

fn decode_frame(expression: &SExpr) -> Result<ContextFrame, String> {
    let fields = exact_record(expression, "frame", 7)?;
    Ok(ContextFrame {
        id: decode_atom(exact_field(fields, 0, "id")?, "frame.id")?,
        body: exact_field(fields, 1, "body")?.to_string(),
        sources: decode_atom_sequence(exact_named_list(fields, 2, "sources")?, "sources")?,
        provenance: decode_provenance(exact_field(fields, 3, "provenance")?)?,
        revision: decode_number(exact_field(fields, 4, "revision")?, "frame.revision")?,
        created_version: decode_number(
            exact_field(fields, 5, "created-version")?,
            "frame.created-version",
        )?,
        updated_version: decode_number(
            exact_field(fields, 6, "updated-version")?,
            "frame.updated-version",
        )?,
    })
}

fn encode_provenance(provenance: &FrameIdentityProvenance) -> SExpr {
    record(
        "frame-provenance",
        vec![
            field(
                "formed-principal-id",
                optional_atom(provenance.formed_principal_id.as_deref()),
            ),
            field(
                "formed-session-id",
                optional_atom(provenance.formed_session_id.as_deref()),
            ),
            atom_sequence("source-principal-ids", &provenance.source_principal_ids),
            atom_sequence("source-session-ids", &provenance.source_session_ids),
            field(
                "state",
                atom(match provenance.state {
                    FrameProvenanceState::Unknown => "unknown",
                    FrameProvenanceState::Unattributed => "unattributed",
                    FrameProvenanceState::Attributed => "attributed",
                }),
            ),
        ],
    )
}

fn decode_provenance(expression: &SExpr) -> Result<FrameIdentityProvenance, String> {
    let fields = exact_record(expression, "frame-provenance", 5)?;
    let state = match decode_atom(exact_field(fields, 4, "state")?, "provenance.state")?.as_str() {
        "unknown" => FrameProvenanceState::Unknown,
        "unattributed" => FrameProvenanceState::Unattributed,
        "attributed" => FrameProvenanceState::Attributed,
        other => return Err(format!("invalid Frame provenance state '{other}'")),
    };
    Ok(FrameIdentityProvenance {
        formed_principal_id: decode_optional_atom(
            exact_field(fields, 0, "formed-principal-id")?,
            "formed-principal-id",
        )?,
        formed_session_id: decode_optional_atom(
            exact_field(fields, 1, "formed-session-id")?,
            "formed-session-id",
        )?,
        source_principal_ids: decode_atom_sequence(
            exact_named_list(fields, 2, "source-principal-ids")?,
            "source-principal-ids",
        )?,
        source_session_ids: decode_atom_sequence(
            exact_named_list(fields, 3, "source-session-ids")?,
            "source-session-ids",
        )?,
        state,
    })
}

fn encode_relation(relation: &ContextRelation) -> SExpr {
    record(
        "relation",
        vec![
            field("subject", atom(&relation.subject)),
            field("relation", atom(&relation.relation)),
            field("object", atom(&relation.object)),
            field("created-version", number(relation.created_version)),
        ],
    )
}

fn decode_relation(expression: &SExpr) -> Result<ContextRelation, String> {
    let fields = exact_record(expression, "relation", 4)?;
    Ok(ContextRelation {
        subject: decode_atom(exact_field(fields, 0, "subject")?, "relation.subject")?,
        relation: decode_atom(exact_field(fields, 1, "relation")?, "relation.relation")?,
        object: decode_atom(exact_field(fields, 2, "object")?, "relation.object")?,
        created_version: decode_number(
            exact_field(fields, 3, "created-version")?,
            "relation.created-version",
        )?,
    })
}

fn identity_entry(kind: &str, id: &str) -> SExpr {
    record(kind, vec![field("id", atom(id))])
}

fn decode_identity_entry(expression: &SExpr, kind: &str) -> Result<String, String> {
    let fields = exact_record(expression, kind, 1)?;
    decode_atom(exact_field(fields, 0, "id")?, &format!("{kind}.id"))
}

fn encode_retirement(retirement: &FrameRetirement) -> SExpr {
    record(
        "retiring-entry",
        vec![
            field("frame-id", atom(&retirement.frame_id)),
            field(
                "requested-frame-revision",
                number(retirement.requested_frame_revision),
            ),
            field(
                "requested-mind-version",
                number(retirement.requested_mind_version),
            ),
            field("requested-at-tick", number(retirement.requested_at_tick)),
            field("eligible-at-tick", number(retirement.eligible_at_tick)),
            field("generation", number(retirement.generation)),
            field("reason", atom(&retirement.reason)),
        ],
    )
}

fn decode_retirement(expression: &SExpr) -> Result<FrameRetirement, String> {
    let fields = exact_record(expression, "retiring-entry", 7)?;
    Ok(FrameRetirement {
        frame_id: decode_atom(exact_field(fields, 0, "frame-id")?, "retirement.frame-id")?,
        requested_frame_revision: decode_number(
            exact_field(fields, 1, "requested-frame-revision")?,
            "retirement.requested-frame-revision",
        )?,
        requested_mind_version: decode_number(
            exact_field(fields, 2, "requested-mind-version")?,
            "retirement.requested-mind-version",
        )?,
        requested_at_tick: decode_number(
            exact_field(fields, 3, "requested-at-tick")?,
            "retirement.requested-at-tick",
        )?,
        eligible_at_tick: decode_number(
            exact_field(fields, 4, "eligible-at-tick")?,
            "retirement.eligible-at-tick",
        )?,
        generation: decode_number(
            exact_field(fields, 5, "generation")?,
            "retirement.generation",
        )?,
        reason: decode_atom(exact_field(fields, 6, "reason")?, "retirement.reason")?,
    })
}

fn encode_checkpoint(checkpoint: &MindCheckpoint) -> Result<SExpr, String> {
    let frames = checkpoint
        .frames
        .iter()
        .map(encode_frame)
        .collect::<Result<Vec<_>, _>>()?;
    let relations = checkpoint
        .relations
        .iter()
        .map(encode_relation)
        .collect::<Vec<_>>();
    let retiring = checkpoint
        .retiring
        .iter()
        .map(|(id, retirement)| {
            SExpr::List(vec![atom("entry"), atom(id), encode_retirement(retirement)])
        })
        .collect::<Vec<_>>();
    Ok(record(
        "checkpoint",
        vec![
            field("id", atom(&checkpoint.id)),
            sequence("frames", frames),
            sequence("relations", relations),
            atom_set("retired", &checkpoint.retired),
            sequence("retiring", retiring),
            atom_set("protected", &checkpoint.protected),
            field("created-version", number(checkpoint.created_version)),
        ],
    ))
}

fn decode_checkpoint(expression: &SExpr) -> Result<MindCheckpoint, String> {
    let fields = exact_record(expression, "checkpoint", 7)?;
    let frames = exact_named_list(fields, 1, "frames")?
        .iter()
        .map(decode_frame)
        .collect::<Result<Vec<_>, _>>()?;
    let relations = exact_named_list(fields, 2, "relations")?
        .iter()
        .map(decode_relation)
        .collect::<Result<Vec<_>, _>>()?;
    let retired = decode_atom_set(exact_named_list(fields, 3, "retired")?, "retired")?;
    let mut retiring = BTreeMap::new();
    for entry in exact_named_list(fields, 4, "retiring")? {
        let parts = list_items(entry, "checkpoint.retiring entry")?;
        if parts.len() != 3 || atom_ref(&parts[0]) != Some("entry") {
            return Err(
                "checkpoint.retiring must contain (entry id (retiring-entry ...)) values"
                    .to_string(),
            );
        }
        let id = decode_atom(&parts[1], "checkpoint.retiring key")?;
        let retirement = decode_retirement(&parts[2])?;
        if retiring.insert(id.clone(), retirement).is_some() {
            return Err(format!("duplicate checkpoint retiring key '{id}'"));
        }
    }
    let protected = decode_atom_set(exact_named_list(fields, 5, "protected")?, "protected")?;
    Ok(MindCheckpoint {
        id: decode_atom(exact_field(fields, 0, "id")?, "checkpoint.id")?,
        frames,
        relations,
        retired,
        retiring,
        protected,
        created_version: decode_number(
            exact_field(fields, 6, "created-version")?,
            "checkpoint.created-version",
        )?,
    })
}

fn encode_mutation_clocks(clocks: &ContextMutationClocks) -> SExpr {
    record(
        "mutation-clocks",
        vec![
            field(
                "tracking-started-version",
                optional_number(clocks.tracking_started_version),
            ),
            u64_map("lifecycle-versions", &clocks.lifecycle_versions),
            u64_map("relation-versions", &clocks.relation_versions),
            field("frame-order-version", number(clocks.frame_order_version)),
            u64_map("checkpoint-versions", &clocks.checkpoint_versions),
            field(
                "global-barrier-version",
                number(clocks.global_barrier_version),
            ),
        ],
    )
}

fn decode_mutation_clocks(expression: &SExpr) -> Result<ContextMutationClocks, String> {
    let fields = exact_record(expression, "mutation-clocks", 6)?;
    Ok(ContextMutationClocks {
        tracking_started_version: decode_optional_number(
            exact_field(fields, 0, "tracking-started-version")?,
            "tracking-started-version",
        )?,
        lifecycle_versions: decode_u64_map(
            exact_named_list(fields, 1, "lifecycle-versions")?,
            "lifecycle-versions",
        )?,
        relation_versions: decode_u64_map(
            exact_named_list(fields, 2, "relation-versions")?,
            "relation-versions",
        )?,
        frame_order_version: decode_number(
            exact_field(fields, 3, "frame-order-version")?,
            "frame-order-version",
        )?,
        checkpoint_versions: decode_u64_map(
            exact_named_list(fields, 4, "checkpoint-versions")?,
            "checkpoint-versions",
        )?,
        global_barrier_version: decode_number(
            exact_field(fields, 5, "global-barrier-version")?,
            "global-barrier-version",
        )?,
    })
}

fn record(head: &str, fields: Vec<SExpr>) -> SExpr {
    let mut values = Vec::with_capacity(fields.len() + 1);
    values.push(atom(head));
    values.extend(fields);
    SExpr::List(values)
}

fn field(name: &str, value: SExpr) -> SExpr {
    SExpr::List(vec![atom(name), value])
}

fn sequence(name: &str, values: Vec<SExpr>) -> SExpr {
    let mut items = Vec::with_capacity(values.len() + 1);
    items.push(atom(name));
    items.extend(values);
    SExpr::List(items)
}

fn atom_sequence(name: &str, values: &[String]) -> SExpr {
    sequence(name, values.iter().map(atom).collect())
}

fn atom_set(name: &str, values: &BTreeSet<String>) -> SExpr {
    sequence(name, values.iter().map(atom).collect())
}

fn u64_map(name: &str, values: &BTreeMap<String, u64>) -> SExpr {
    sequence(
        name,
        values
            .iter()
            .map(|(key, value)| SExpr::List(vec![atom("entry"), atom(key), number(*value)]))
            .collect(),
    )
}

fn atom(value: impl ToString) -> SExpr {
    SExpr::Atom(value.to_string())
}

fn number(value: u64) -> SExpr {
    atom(value)
}

fn optional_atom(value: Option<&str>) -> SExpr {
    match value {
        Some(value) => SExpr::List(vec![atom("some"), atom(value)]),
        None => SExpr::List(vec![atom("none")]),
    }
}

fn optional_number(value: Option<u64>) -> SExpr {
    match value {
        Some(value) => SExpr::List(vec![atom("some"), number(value)]),
        None => SExpr::List(vec![atom("none")]),
    }
}

fn canonical_string(expression: SExpr) -> Result<String, String> {
    let encoded = expression.to_string();
    let parsed = parse_canonical(&encoded)?;
    if parsed != expression {
        return Err("Context AST codec failed its canonical in-memory round trip".to_string());
    }
    Ok(encoded)
}

fn parse_canonical(body: &str) -> Result<SExpr, String> {
    let mut forms = sexpr::parse_all(body).map_err(|error| error.to_string())?;
    if forms.len() != 1 {
        return Err(format!(
            "persistent Context Node must contain exactly one S-expression, got {}",
            forms.len()
        ));
    }
    let expression = forms.remove(0);
    if expression.to_string() != body {
        return Err("persistent Context Node is not in canonical S-expression form".to_string());
    }
    Ok(expression)
}

fn ensure_round_trip(input: &str, encoded: String) -> Result<(), String> {
    if input == encoded {
        Ok(())
    } else {
        Err("persistent Context Node does not match the canonical native AST schema".to_string())
    }
}

fn exact_record<'a>(
    expression: &'a SExpr,
    expected_head: &str,
    field_count: usize,
) -> Result<&'a [SExpr], String> {
    let items = list_items(expression, expected_head)?;
    if items.len() != field_count + 1 || atom_ref(&items[0]) != Some(expected_head) {
        return Err(format!(
            "expected canonical ({expected_head} ...) record with {field_count} fields"
        ));
    }
    Ok(&items[1..])
}

fn exact_field<'a>(
    fields: &'a [SExpr],
    index: usize,
    expected_name: &str,
) -> Result<&'a SExpr, String> {
    let pair = fields
        .get(index)
        .ok_or_else(|| format!("missing canonical field '{expected_name}'"))?;
    let items = list_items(pair, expected_name)?;
    if items.len() != 2 || atom_ref(&items[0]) != Some(expected_name) {
        return Err(format!(
            "expected canonical field ({expected_name} value) at position {index}"
        ));
    }
    Ok(&items[1])
}

fn exact_named_list<'a>(
    fields: &'a [SExpr],
    index: usize,
    expected_name: &str,
) -> Result<&'a [SExpr], String> {
    let expression = fields
        .get(index)
        .ok_or_else(|| format!("missing canonical list '{expected_name}'"))?;
    let items = list_items(expression, expected_name)?;
    if items.first().and_then(atom_ref) != Some(expected_name) {
        return Err(format!(
            "expected canonical list '({expected_name} ...)' at position {index}"
        ));
    }
    Ok(&items[1..])
}

fn list_items<'a>(expression: &'a SExpr, label: &str) -> Result<&'a [SExpr], String> {
    match expression {
        SExpr::List(items) => Ok(items),
        SExpr::Atom(_) => Err(format!("{label} must be an S-expression list")),
    }
}

fn atom_ref(expression: &SExpr) -> Option<&str> {
    match expression {
        SExpr::Atom(value) => Some(value),
        SExpr::List(_) => None,
    }
}

fn decode_atom(expression: &SExpr, label: &str) -> Result<String, String> {
    atom_ref(expression)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("{label} must be an atom"))
}

fn decode_number(expression: &SExpr, label: &str) -> Result<u64, String> {
    let encoded = decode_atom(expression, label)?;
    let value = encoded
        .parse::<u64>()
        .map_err(|error| format!("{label} is not a u64: {error}"))?;
    if encoded != value.to_string() {
        return Err(format!("{label} is not in canonical u64 form"));
    }
    Ok(value)
}

fn decode_optional_atom(expression: &SExpr, label: &str) -> Result<Option<String>, String> {
    let items = list_items(expression, label)?;
    match items {
        [SExpr::Atom(head)] if head == "none" => Ok(None),
        [SExpr::Atom(head), SExpr::Atom(value)] if head == "some" => Ok(Some(value.clone())),
        _ => Err(format!("{label} must be (none) or (some value)")),
    }
}

fn decode_optional_number(expression: &SExpr, label: &str) -> Result<Option<u64>, String> {
    let items = list_items(expression, label)?;
    match items {
        [SExpr::Atom(head)] if head == "none" => Ok(None),
        [SExpr::Atom(head), value] if head == "some" => decode_number(value, label).map(Some),
        _ => Err(format!("{label} must be (none) or (some u64)")),
    }
}

fn decode_atom_sequence(items: &[SExpr], label: &str) -> Result<Vec<String>, String> {
    items.iter().map(|item| decode_atom(item, label)).collect()
}

fn decode_atom_set(items: &[SExpr], label: &str) -> Result<BTreeSet<String>, String> {
    let values = decode_atom_sequence(items, label)?;
    let set = values.iter().cloned().collect::<BTreeSet<_>>();
    if set.len() != values.len() {
        return Err(format!("{label} contains a duplicate value"));
    }
    if set.iter().ne(values.iter()) {
        return Err(format!("{label} is not in canonical sorted order"));
    }
    Ok(set)
}

fn decode_u64_map(items: &[SExpr], label: &str) -> Result<BTreeMap<String, u64>, String> {
    let mut map = BTreeMap::new();
    let mut previous: Option<String> = None;
    for expression in items {
        let entry = list_items(expression, label)?;
        if entry.len() != 3 || atom_ref(&entry[0]) != Some("entry") {
            return Err(format!("{label} must contain (entry key u64) values"));
        }
        let key = decode_atom(&entry[1], label)?;
        if previous.as_ref().is_some_and(|prior| prior >= &key) {
            return Err(format!("{label} keys are not unique and sorted"));
        }
        let value = decode_number(&entry[2], label)?;
        map.insert(key.clone(), value);
        previous = Some(key);
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_frame() -> ContextFrame {
        let body = sexpr::parse("(fact (text \"hello world\\n你好\") (path \"a path\\\\b\"))")
            .unwrap()
            .to_string();
        ContextFrame {
            id: "frame-一".to_string(),
            body,
            sources: vec!["obs-1".to_string(), "obs (2)".to_string()],
            provenance: FrameIdentityProvenance {
                formed_principal_id: Some("principal one".to_string()),
                formed_session_id: None,
                source_principal_ids: vec!["p-1".to_string()],
                source_session_ids: vec!["s-1".to_string(), "s-2".to_string()],
                state: FrameProvenanceState::Attributed,
            },
            revision: 3,
            created_version: 2,
            updated_version: 7,
        }
    }

    fn assert_value_round_trip(value: ContextNodeValue) {
        let collection = value.collection();
        let encoded = encode_context_value(&value).unwrap();
        assert!(!encoded.contains("morphz-record"));
        assert!(!encoded.contains("eyJ"));
        assert_eq!(decode_context_value(&encoded, collection).unwrap(), value);
    }

    #[test]
    fn every_native_value_round_trips_without_json_envelope() {
        let frame = sample_frame();
        let relation = ContextRelation {
            subject: frame.id.clone(),
            relation: "supersedes".to_string(),
            object: "old frame".to_string(),
            created_version: 8,
        };
        let retirement = FrameRetirement {
            frame_id: frame.id.clone(),
            requested_frame_revision: 3,
            requested_mind_version: 8,
            requested_at_tick: 10,
            eligible_at_tick: 12,
            generation: 2,
            reason: "已经过时 (verified)".to_string(),
        };
        let checkpoint = MindCheckpoint {
            id: "checkpoint-1".to_string(),
            frames: vec![frame.clone()],
            relations: vec![relation.clone()],
            retired: BTreeSet::from(["old frame".to_string()]),
            retiring: BTreeMap::from([(frame.id.clone(), retirement.clone())]),
            protected: BTreeSet::from([frame.id.clone()]),
            created_version: 9,
        };
        let clocks = ContextMutationClocks {
            tracking_started_version: Some(1),
            lifecycle_versions: BTreeMap::from([("frame-一".to_string(), 9)]),
            relation_versions: BTreeMap::from([("edge 1".to_string(), 8)]),
            frame_order_version: 7,
            checkpoint_versions: BTreeMap::from([("checkpoint-1".to_string(), 9)]),
            global_barrier_version: 0,
        };

        for value in [
            ContextNodeValue::Frame(frame),
            ContextNodeValue::Relation(relation),
            ContextNodeValue::Retired("old frame".to_string()),
            ContextNodeValue::Retiring(retirement),
            ContextNodeValue::Protected("frame-一".to_string()),
            ContextNodeValue::Checkpoint(checkpoint),
            ContextNodeValue::MutationClocks(clocks),
        ] {
            assert_value_round_trip(value);
        }
    }

    #[test]
    fn frame_body_is_a_nested_ast_not_an_escaped_payload() {
        let encoded = encode_context_value(&ContextNodeValue::Frame(sample_frame())).unwrap();
        assert!(encoded.contains("(body (fact (text "));
        assert!(encoded.contains("你好"));
        assert!(!encoded.contains("base64"));
        assert!(!encoded.contains("{\\\"id\\\""));
    }

    #[test]
    fn decoder_fails_closed_on_extra_reordered_or_noncanonical_fields() {
        let encoded = encode_context_value(&ContextNodeValue::Frame(sample_frame())).unwrap();
        let extra = encoded.replacen("(revision 3)", "(unknown x) (revision 3)", 1);
        assert!(decode_context_value(&extra, ContextCollection::Frame).is_err());
        let reordered = encoded.replacen(
            "(revision 3) (created-version 2)",
            "(created-version 2) (revision 3)",
            1,
        );
        assert!(decode_context_value(&reordered, ContextCollection::Frame).is_err());
        let noncanonical = encoded.replacen("(revision 3)", "(revision 03)", 1);
        assert!(decode_context_value(&noncanonical, ContextCollection::Frame).is_err());
    }

    #[test]
    fn head_round_trips_in_native_form() {
        let head = ContextAstHead {
            revision: 7,
            state_hash: "abc 123".to_string(),
            head_event_id: Some("event (7)".to_string()),
            updated_at: DateTime::parse_from_rfc3339("2026-09-02T03:04:05.123456789Z")
                .unwrap()
                .with_timezone(&Utc),
        };
        let encoded = encode_context_head(&head).unwrap();
        assert_eq!(decode_context_head(&encoded).unwrap(), head);
        assert!(encoded.starts_with("(projection-meta "));
        assert!(!encoded.contains("morphz-record"));
    }

    #[test]
    fn native_mind_commitment_preserves_vector_order_and_canonicalizes_sets() {
        let first = sample_frame();
        let mut second = sample_frame();
        second.id = "frame-二".to_string();
        second.body = "(fact second)".to_string();

        let state = MindState {
            version: 4,
            frames: vec![first.clone(), second.clone()],
            retired: BTreeSet::from(["z".to_string(), "a".to_string()]),
            protected: BTreeSet::from(["p2".to_string(), "p1".to_string()]),
            ..Default::default()
        };
        let canonical = native_mind_state_hash(&state).unwrap();

        let mut same_sets = state.clone();
        same_sets.retired.clear();
        same_sets.retired.insert("a".to_string());
        same_sets.retired.insert("z".to_string());
        same_sets.protected.clear();
        same_sets.protected.insert("p1".to_string());
        same_sets.protected.insert("p2".to_string());
        assert_eq!(canonical, native_mind_state_hash(&same_sets).unwrap());

        let mut reordered = state;
        reordered.frames.swap(0, 1);
        assert_ne!(canonical, native_mind_state_hash(&reordered).unwrap());
    }
}
