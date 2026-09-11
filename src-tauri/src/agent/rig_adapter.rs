//! The only module allowed to import Rig crates directly.
//!
//! Rig is pinned to 0.42.0. Product code imports this facade so a future Rig
//! migration has one compile-time boundary even though portable message types
//! are passed to the FloatNote session adapter.

pub(crate) use rig_agent::{
    agent,
    prelude::{MultiTurnStreamItem, Prompt, StreamingPrompt},
    tool, AgentBuilder, ModelHandle,
};
pub(crate) use rig_core::{client, completion, message, providers, streaming};
