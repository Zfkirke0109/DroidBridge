use crate::{companion::CompanionPort, magisk_guard_recovery::ProcFacts, magisk_host::new_uuid};
use contract::UuidV4;
use domain::DomainError;
use persistence::{
    GuardProofDirectory, GuardRecoveryPlan, LifetimeLease, StateStore, build_guard_recovery_plan,
};
use runtime::ApkCapabilityPort;
use std::{
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

/// How long a requested recycle waits before it interrupts the connection loop, so the
/// settlement that requested it commits and answers first.
const SETTLE_WINDOW: Duration = Duration::from_secs(2);

/// The bound on the orderly shutdown of a recycling daemon; work that outlives it is ended by
/// the exit, and the guards' lifetime pipes turn that into owner-lost cleanup.
const SHUTDOWN_BOUND: Duration = Duration::from_secs(10);

/// How often an instance whose cleanup is unresolved reads the guard proofs again.
const WATCH_POLL: Duration = Duration::from_secs(1);

/// This daemon's decision to replace itself. An execution whose cleanup it cannot prove leaves
/// the instance unable to admit work again, so it exits and the supervisor starts a fresh one,
/// whose startup recovery reads the guard proofs the exit let settle.
#[derive(Default)]
pub(crate) struct Recycle {
    state: Mutex<State>,
    wake: Condvar,
}

#[derive(Clone, Copy, Default, Eq, PartialEq)]
enum State {
    #[default]
    Serving,
    Settling,
    Due,
}

impl Recycle {
    pub(crate) fn request(self: &Arc<Self>, companion: CompanionPort) {
        {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            if *state != State::Serving {
                return;
            }
            *state = State::Settling;
        }
        let recycle = Arc::clone(self);
        thread::spawn(move || {
            thread::sleep(SETTLE_WINDOW);
            *recycle.state.lock().unwrap_or_else(PoisonError::into_inner) = State::Due;
            recycle.wake.notify_all();
            companion.close_live();
        });
    }

    pub(crate) fn due(&self) -> bool {
        *self.state.lock().unwrap_or_else(PoisonError::into_inner) == State::Due
    }

    /// Sleeps at most [duration], returning early once a requested recycle is due.
    pub(crate) fn sleep(&self, duration: Duration) {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let _ = self
            .wake
            .wait_timeout_while(state, duration, |state| *state != State::Due);
    }

    /// Bounds the orderly shutdown that follows: the process exits once it is done or once
    /// [SHUTDOWN_BOUND] has passed.
    pub(crate) fn bound_shutdown() {
        thread::spawn(|| {
            thread::sleep(SHUTDOWN_BOUND);
            eprintln!("droidbridged: recycle shutdown exceeded its bound; exiting");
            std::process::exit(1);
        });
    }
}

/// Resolves this instance's lost readiness from the guard proofs alone (S-EXEC-001). It reads
/// them exactly as a fresh instance's startup recovery would: once that recovery would be clean,
/// this instance is replaced. Until then readiness says whether every unproven guard is still
/// alive to write its verdict, or whether one died without it and only a reboot resolves it.
#[derive(Clone)]
pub(crate) struct CleanupWatch {
    store: Arc<StateStore>,
    lease: Arc<LifetimeLease>,
    canonical_base: PathBuf,
    boot_id: UuidV4,
    companion: CompanionPort,
    capabilities: ApkCapabilityPort,
    recycle: Arc<Recycle>,
    watching: Arc<AtomicBool>,
}

impl CleanupWatch {
    pub(crate) fn new(
        store: Arc<StateStore>,
        lease: Arc<LifetimeLease>,
        canonical_base: PathBuf,
        boot_id: UuidV4,
        companion: CompanionPort,
        capabilities: ApkCapabilityPort,
        recycle: Arc<Recycle>,
    ) -> Self {
        Self {
            store,
            lease,
            canonical_base,
            boot_id,
            companion,
            capabilities,
            recycle,
            watching: Arc::default(),
        }
    }

    /// Withdraws readiness under the reason the proofs support now and keeps reading them.
    pub(crate) fn start(&self) -> Result<(), DomainError> {
        self.capabilities
            .withdraw_readiness_as(reason(self.fresh_plan().as_ref()))?;
        if self.watching.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let watch = self.clone();
        thread::spawn(move || {
            loop {
                let plan = watch.fresh_plan();
                if plan
                    .as_ref()
                    .is_some_and(GuardRecoveryPlan::guards_are_clean)
                {
                    watch.recycle.request(watch.companion.clone());
                    return;
                }
                let _ = watch
                    .capabilities
                    .withdraw_readiness_as(reason(plan.as_ref()));
                thread::sleep(WATCH_POLL);
            }
        });
        Ok(())
    }

    /// Whether the readiness of this instance now follows the guard proofs.
    pub(crate) fn active(&self) -> bool {
        self.watching.load(Ordering::Acquire)
    }

    /// The startup recovery plan of an instance that does not exist yet, so every proof is read
    /// as one a replacement would inherit.
    fn fresh_plan(&self) -> Option<GuardRecoveryPlan> {
        let state = self.store.load(&self.lease).ok()?;
        build_guard_recovery_plan(
            &state,
            &new_uuid().ok()?,
            &self.boot_id,
            &GuardProofDirectory::new(&self.canonical_base),
            &ProcFacts,
        )
        .ok()
    }
}

fn reason(plan: Option<&GuardRecoveryPlan>) -> &'static str {
    if plan.is_some_and(GuardRecoveryPlan::may_settle) {
        "EXECUTOR_RECOVERING"
    } else {
        "CLEANUP_UNVERIFIED"
    }
}

#[cfg(test)]
mod tests {
    use super::Recycle;
    use crate::companion::CompanionPort;
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    #[test]
    fn a_request_becomes_due_after_the_settle_window_and_wakes_a_sleeping_loop() {
        let recycle = Arc::new(Recycle::default());
        recycle.request(CompanionPort::default());
        recycle.request(CompanionPort::default());
        assert!(!recycle.due());
        let started = Instant::now();
        recycle.sleep(Duration::from_secs(30));
        assert!(recycle.due());
        assert!(started.elapsed() >= Duration::from_secs(2));
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
