//! In-process Rust/Rig Agent runtime and controlled workspace transactions.
//!
//! Rust is the sole runtime and authority: Rig drives provider streaming and
//! tool calls, while FloatNote owns sessions, Skills, permissions and files.
//!
//! 模块拆分：
//! - [`protocol`] — stable WebView event and domain DTOs.
//! - [`provider`] / [`service`] — pinned Rig adapter and lifecycle.
//! - [`session`] / [`skills`] — durable branches, Pi import and Skill snapshots.
//! - [`tools`] — Rig tools plus streaming lifecycle hooks.
//! - [`workspace`] — 虚拟工作区读取与 mutation transaction。

mod note_logic;
mod presentation;
mod protocol;
mod provider;
mod rig_adapter;
mod service;
mod session;
mod skills;
mod tools;
pub(crate) mod workspace;

pub(crate) use note_logic::*;
pub use presentation::*;
pub use protocol::*;
pub use provider::*;
pub use service::*;
pub use session::*;
pub use skills::*;
pub(crate) use tools::*;
pub(crate) use workspace::*;
