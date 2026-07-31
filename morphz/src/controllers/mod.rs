//! Policy layer above the deterministic Scheduler Kernel.
//!
//! Controllers lower domain intent into fenced [`crate::scheduler::KernelCommand`]
//! values. They never receive a persistence store and therefore cannot bypass
//! the Kernel transaction boundary.

pub mod delivery;
pub mod dialogue;
pub mod objective;
pub mod plan;
pub mod timer;

pub use delivery::DeliveryController;
pub use dialogue::DialogueController;
pub use objective::ObjectiveController;
pub use plan::PlanController;
pub use timer::TimerController;
