//! Versioned trust/provenance envelope shared conceptually with the frontend
//! and sidecar. The envelope stores safe identity metadata and lineage only;
//! raw evidence, credentials, and command strings stay in their owning record.

use serde::{Deserialize, Serialize};

pub const PROVENANCE_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProvenanceOrigin {
    User,
    LocalWorkspace,
    RemoteWorkspace,
    Web,
    Mcp,
    ImportedFile,
    Memory,
    Agent,
    GeneratedDerivative,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProvenanceAuthority {
    UserIntent,
    PolicyAuthorized,
    EvidenceOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProvenanceTransform {
    Truncated,
    Extracted,
    Redacted,
    Summarized,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceIdentity {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locator: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IntegrityState {
    Verified,
    Unverified,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceIntegrity {
    pub captured_at: u64,
    pub state: IntegrityState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash_algorithm: Option<String>,
    pub transforms: Vec<ProvenanceTransform>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceLineage {
    pub parent_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceEnvelope {
    pub schema_version: u8,
    pub id: String,
    pub origin: ProvenanceOrigin,
    pub authority: ProvenanceAuthority,
    pub identity: ProvenanceIdentity,
    pub integrity: ProvenanceIntegrity,
    pub lineage: ProvenanceLineage,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_serializes_every_origin_authority_and_transform() {
        let origins = [
            ProvenanceOrigin::User,
            ProvenanceOrigin::LocalWorkspace,
            ProvenanceOrigin::RemoteWorkspace,
            ProvenanceOrigin::Web,
            ProvenanceOrigin::Mcp,
            ProvenanceOrigin::ImportedFile,
            ProvenanceOrigin::Memory,
            ProvenanceOrigin::Agent,
            ProvenanceOrigin::GeneratedDerivative,
            ProvenanceOrigin::Unknown,
        ];
        let authorities = [
            ProvenanceAuthority::UserIntent,
            ProvenanceAuthority::PolicyAuthorized,
            ProvenanceAuthority::EvidenceOnly,
        ];
        let transforms = vec![
            ProvenanceTransform::Truncated,
            ProvenanceTransform::Extracted,
            ProvenanceTransform::Redacted,
            ProvenanceTransform::Summarized,
        ];

        for (index, origin) in origins.into_iter().enumerate() {
            let envelope = ProvenanceEnvelope {
                schema_version: PROVENANCE_SCHEMA_VERSION,
                id: format!("fixture-{index}"),
                origin,
                authority: authorities[index % authorities.len()].clone(),
                identity: ProvenanceIdentity {
                    label: "fixture".to_string(),
                    locator: None,
                },
                integrity: ProvenanceIntegrity {
                    captured_at: 1,
                    state: IntegrityState::Unknown,
                    content_hash: None,
                    hash_algorithm: None,
                    transforms: transforms.clone(),
                },
                lineage: ProvenanceLineage { parent_ids: vec![] },
            };
            let json = serde_json::to_string(&envelope).expect("serialize provenance");
            let decoded: ProvenanceEnvelope =
                serde_json::from_str(&json).expect("deserialize provenance");
            assert_eq!(decoded, envelope);
        }
    }
}
