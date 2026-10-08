//! The Magisk host's Automation time-wake projection (S-LIFE-003): one nonblocking CLOEXEC
//! CLOCK_REALTIME_ALARM timerfd in the Runtime's Tokio reactor, armed with
//! TFD_TIMER_ABSTIME|TFD_TIMER_CANCEL_ON_SET at the earliest persisted due. It copies no schedule:
//! both an expiry and an ECANCELED wall-clock set only ask the scheduler to rescan canonical truth.

use contract::ErrorCode;
use domain::DomainError;
use runtime::{AutomationWakeDue, AutomationWakeProjection, PortFuture};
use std::{
    io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
};
use tokio::io::{Interest, unix::AsyncFd};

pub(crate) struct RealtimeAlarmWake {
    timer: AsyncFd<OwnedFd>,
}

impl RealtimeAlarmWake {
    /// Creates the disarmed timer. It must be called inside the Runtime's Tokio reactor.
    pub(crate) fn new() -> Result<Self, DomainError> {
        let descriptor = unsafe {
            libc::timerfd_create(
                libc::CLOCK_REALTIME_ALARM,
                libc::TFD_NONBLOCK | libc::TFD_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return Err(wake_error(
                "wake alarm timer creation failed",
                &io::Error::last_os_error(),
            ));
        }
        // SAFETY: timerfd_create returned a new descriptor that nothing else owns.
        let timer = unsafe { OwnedFd::from_raw_fd(descriptor) };
        let timer = AsyncFd::with_interest(timer, Interest::READABLE)
            .map_err(|error| wake_error("wake alarm timer registration failed", &error))?;
        Ok(Self { timer })
    }

    fn settime(&self, flags: libc::c_int, value: libc::timespec) -> Result<(), DomainError> {
        let spec = libc::itimerspec {
            it_interval: libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            },
            it_value: value,
        };
        // SAFETY: the descriptor is a live timerfd owned by `self`, and `spec` outlives the call.
        let result = unsafe {
            libc::timerfd_settime(
                self.timer.get_ref().as_raw_fd(),
                flags,
                &spec,
                std::ptr::null_mut(),
            )
        };
        if result != 0 {
            let error = io::Error::last_os_error();
            // timerfd_settime installs the new timer even when it reports ECANCELED for an
            // unread wall-clock cancellation of the previous timer (timerfd_create(2), NOTES).
            if error.raw_os_error() != Some(libc::ECANCELED) {
                return Err(wake_error("wake alarm timer arm failed", &error));
            }
        }
        Ok(())
    }
}

impl AutomationWakeProjection for RealtimeAlarmWake {
    fn arm(&self, due: Option<&AutomationWakeDue>) -> Result<bool, DomainError> {
        let Some(due) = due else {
            // An all-zero value disarms; an idle daemon keeps no periodic wake.
            self.settime(
                0,
                libc::timespec {
                    tv_sec: 0,
                    tv_nsec: 0,
                },
            )?;
            return Ok(true);
        };
        // A due at or before the epoch cannot be persisted; clamp to the smallest armed value so
        // an all-zero it_value never silently disarms an expired due.
        let millis = due.unix_millis.max(1);
        let seconds = libc::time_t::try_from(millis.div_euclid(1_000))
            .map_err(|_| DomainError::new(ErrorCode::ResourceLimit, "wake due is out of range"))?;
        let nanos = libc::c_long::try_from(millis.rem_euclid(1_000) * 1_000_000)
            .map_err(|_| DomainError::new(ErrorCode::ResourceLimit, "wake due is out of range"))?;
        self.settime(
            libc::TFD_TIMER_ABSTIME | libc::TFD_TIMER_CANCEL_ON_SET,
            libc::timespec {
                tv_sec: seconds,
                tv_nsec: nanos,
            },
        )?;
        Ok(true)
    }

    fn wait<'a>(&'a self) -> PortFuture<'a, Result<(), DomainError>> {
        Box::pin(async move {
            loop {
                let mut ready = self
                    .timer
                    .readable()
                    .await
                    .map_err(|error| wake_error("wake alarm timer wait failed", &error))?;
                let mut expirations = [0_u8; 8];
                // The read consumes the delivery synchronously after readiness, so dropping this
                // future at its only await point loses nothing.
                match ready.try_io(|inner| {
                    // SAFETY: the descriptor is live and `expirations` is a writable 8-byte buffer.
                    let read = unsafe {
                        libc::read(
                            inner.get_ref().as_raw_fd(),
                            expirations.as_mut_ptr().cast(),
                            expirations.len(),
                        )
                    };
                    if read < 0 {
                        Err(io::Error::last_os_error())
                    } else {
                        Ok(read)
                    }
                }) {
                    Ok(Ok(8)) => return Ok(()),
                    // The wall clock was set while armed: canonical truth is rescanned.
                    Ok(Err(error)) if error.raw_os_error() == Some(libc::ECANCELED) => {
                        return Ok(());
                    }
                    Ok(Ok(_)) => {
                        return Err(DomainError::new(
                            ErrorCode::IoError,
                            "wake alarm timer read failed",
                        ));
                    }
                    Ok(Err(error)) => {
                        return Err(wake_error("wake alarm timer read failed", &error));
                    }
                    Err(_would_block) => {}
                }
            }
        })
    }
}

fn wake_error(message: &'static str, error: &io::Error) -> DomainError {
    DomainError::os(ErrorCode::IoError, message, error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clock(id: libc::clockid_t) -> io::Result<libc::timespec> {
        let mut value = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `value` is writable for the duration of the call.
        if unsafe { libc::clock_gettime(id, &mut value) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(value)
    }

    fn remaining(wake: &RealtimeAlarmWake) -> io::Result<libc::itimerspec> {
        let mut value = libc::itimerspec {
            it_interval: libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            },
            it_value: libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            },
        };
        // SAFETY: the timer is owned by `wake`, and `value` is writable.
        if unsafe { libc::timerfd_gettime(wake.timer.get_ref().as_raw_fd(), &mut value) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(value)
    }

    fn realtime_timer() -> RealtimeAlarmWake {
        // Ordinary tests use CLOCK_REALTIME so they need no CAP_WAKE_ALARM.
        // SAFETY: timerfd_create has no pointer arguments.
        let descriptor = unsafe {
            libc::timerfd_create(libc::CLOCK_REALTIME, libc::TFD_NONBLOCK | libc::TFD_CLOEXEC)
        };
        assert!(descriptor >= 0, "{}", io::Error::last_os_error());
        // SAFETY: this is a newly created descriptor with no other owner.
        let timer = unsafe { OwnedFd::from_raw_fd(descriptor) };
        RealtimeAlarmWake {
            timer: AsyncFd::with_interest(timer, Interest::READABLE).unwrap(),
        }
    }

    #[tokio::test]
    async fn arm_and_disarm_update_the_kernel_timer() {
        let wake = realtime_timer();
        let wall = clock(libc::CLOCK_REALTIME).unwrap();
        wake.settime(
            libc::TFD_TIMER_ABSTIME | libc::TFD_TIMER_CANCEL_ON_SET,
            libc::timespec {
                tv_sec: wall.tv_sec + 30,
                tv_nsec: wall.tv_nsec,
            },
        )
        .unwrap();
        assert!(remaining(&wake).unwrap().it_value.tv_sec > 0);
        assert_eq!(wake.arm(None), Ok(true));
        let remaining = remaining(&wake).unwrap();
        assert_eq!(
            (remaining.it_value.tv_sec, remaining.it_value.tv_nsec),
            (0, 0)
        );
    }

    #[tokio::test]
    async fn invalid_time_keeps_the_operating_system_error() {
        let wake = realtime_timer();
        let error = wake
            .settime(
                0,
                libc::timespec {
                    tv_sec: 1,
                    tv_nsec: 1_000_000_000,
                },
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::IoError);
        assert_eq!(error.os_error, Some(libc::EINVAL));
        assert_eq!(error.reason, "wake alarm timer arm failed");
    }

    struct ClockRestore {
        wall: libc::timespec,
        mono: libc::timespec,
        restored: bool,
    }

    impl ClockRestore {
        fn restore(&mut self) -> io::Result<()> {
            if self.restored {
                return Ok(());
            }
            let now = clock(libc::CLOCK_MONOTONIC)?;
            let elapsed_ns = (i128::from(now.tv_sec) - i128::from(self.mono.tv_sec))
                * 1_000_000_000
                + i128::from(now.tv_nsec)
                - i128::from(self.mono.tv_nsec);
            let restored_ns = i128::from(self.wall.tv_sec) * 1_000_000_000
                + i128::from(self.wall.tv_nsec)
                + elapsed_ns;
            let restored = libc::timespec {
                tv_sec: restored_ns.div_euclid(1_000_000_000).try_into().unwrap(),
                tv_nsec: restored_ns.rem_euclid(1_000_000_000).try_into().unwrap(),
            };
            // SAFETY: `restored` is initialized and remains live for the call.
            if unsafe { libc::clock_settime(libc::CLOCK_REALTIME, &restored) } != 0 {
                return Err(io::Error::last_os_error());
            }
            self.restored = true;
            Ok(())
        }
    }

    impl Drop for ClockRestore {
        fn drop(&mut self) {
            if !self.restored
                && let Err(error) = self.restore()
            {
                eprintln!("test clock restoration failed: {error}");
            }
        }
    }

    #[tokio::test]
    #[ignore = "requires an authorized isolated root device; briefly changes the system clock"]
    async fn rearm_after_clock_change_keeps_alarm() {
        let wake = RealtimeAlarmWake::new().unwrap();
        let mut restore = ClockRestore {
            wall: clock(libc::CLOCK_REALTIME).unwrap(),
            mono: clock(libc::CLOCK_MONOTONIC).unwrap(),
            restored: true,
        };
        let due = libc::timespec {
            tv_sec: restore.wall.tv_sec + 30,
            tv_nsec: restore.wall.tv_nsec,
        };
        let flags = libc::TFD_TIMER_ABSTIME | libc::TFD_TIMER_CANCEL_ON_SET;
        wake.settime(flags, due).unwrap();
        let shifted = libc::timespec {
            tv_sec: restore.wall.tv_sec + 1,
            tv_nsec: restore.wall.tv_nsec,
        };
        // SAFETY: `shifted` is initialized and remains live for the call.
        let change = unsafe { libc::clock_settime(libc::CLOCK_REALTIME, &shifted) };
        let change_error = (change != 0).then(io::Error::last_os_error);
        restore.restored = change != 0;
        // Keep assertions outside the interval in which the wall clock is shifted.
        let rearmed = wake.settime(flags, due);
        let rearmed_timer = remaining(&wake);
        let restored = restore.restore();
        restored.unwrap();
        let final_mono = clock(libc::CLOCK_MONOTONIC).unwrap();
        let final_wall = clock(libc::CLOCK_REALTIME).unwrap();
        let delta_ns = (i128::from(final_wall.tv_sec)
            - i128::from(restore.wall.tv_sec)
            - i128::from(final_mono.tv_sec)
            + i128::from(restore.mono.tv_sec))
            * 1_000_000_000
            + i128::from(final_wall.tv_nsec)
            - i128::from(restore.wall.tv_nsec)
            - i128::from(final_mono.tv_nsec)
            + i128::from(restore.mono.tv_nsec);
        assert!(
            delta_ns.abs() < 10_000_000,
            "clock restoration delta: {delta_ns} ns"
        );
        println!("clock restoration delta: {delta_ns} ns");
        assert!(change_error.is_none(), "{change_error:?}");
        assert!(rearmed_timer.unwrap().it_value.tv_sec > 0);
        rearmed.unwrap();
        assert_eq!(wake.arm(None), Ok(true));
        // Alarm gettime can retain the previous expiry after disarm on older kernels.
        // Verify cancellation by observing no delivery past a short timer's deadline.
        for disarm in [true, false] {
            let wall = clock(libc::CLOCK_REALTIME).unwrap();
            let nanos = wall.tv_nsec + 200_000_000;
            wake.settime(
                flags,
                libc::timespec {
                    tv_sec: wall.tv_sec + nanos / 1_000_000_000,
                    tv_nsec: nanos % 1_000_000_000,
                },
            )
            .unwrap();
            if disarm {
                assert_eq!(wake.arm(None), Ok(true));
                assert!(
                    tokio::time::timeout(std::time::Duration::from_millis(400), wake.wait())
                        .await
                        .is_err()
                );
            } else {
                tokio::time::timeout(std::time::Duration::from_secs(2), wake.wait())
                    .await
                    .unwrap()
                    .unwrap();
            }
        }
        let expired = remaining(&wake).unwrap();
        assert_eq!((expired.it_value.tv_sec, expired.it_value.tv_nsec), (0, 0));
    }
}
