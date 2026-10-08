use crate::{ExecutionClass, ExecutionId, ProtocolVersion, UuidV4};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, JsonSchema, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fence {
    pub runtime_epoch: UuidV4,
    pub host_generation: u64,
    pub runtime_instance_id: UuidV4,
}
#[derive(Clone, Debug, JsonSchema, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InternalExecutionEnvelope<T> {
    pub protocol_version: ProtocolVersion,
    pub execution_id: ExecutionId,
    pub execution_class: ExecutionClass,
    pub fence: Fence,
    pub payload: T,
}
