//! I8-ANDROID Magisk helper family independence.

use contract::CapabilityState;
use daemon::{HelperFamily, helper_family_facts, reprobe_families};

fn projection(
    facts: [daemon::HelperFamilyFact; 3],
) -> [(&'static str, CapabilityState, Option<&'static str>); 3] {
    facts.map(|fact| (fact.family.key(), fact.state, fact.reason))
}

#[test]
fn i8_android_g09_each_helper_family_remains_available_when_a_sibling_probe_fails() {
    let available = CapabilityState::Available;
    let unavailable = CapabilityState::Unavailable;
    assert_eq!(
        projection(helper_family_facts(true, |family| family != HelperFamily::Clipboard)),
        [
            ("magisk.launch", available, None),
            (
                "magisk.clipboard",
                unavailable,
                Some("CLIPBOARD_PROBE_FAILED")
            ),
            ("magisk.notifications", available, None),
        ]
    );
    assert_eq!(
        projection(helper_family_facts(false, |_| true)),
        [
            ("magisk.launch", unavailable, Some("HELPER_UNAVAILABLE")),
            ("magisk.clipboard", unavailable, Some("HELPER_UNAVAILABLE")),
            (
                "magisk.notifications",
                unavailable,
                Some("HELPER_UNAVAILABLE")
            ),
        ]
    );
}

#[test]
fn a_denied_operation_withdraws_its_family_only_when_the_family_probe_fails_again() {
    let launch_denied = |family| family == HelperFamily::Launch;
    let mut probed = Vec::new();
    // The launch probe still succeeds: the denial was that one operation's answer.
    assert_eq!(
        reprobe_families([true; 3], launch_denied, false, |family| {
            probed.push(family);
            true
        }),
        [true; 3]
    );
    assert_eq!(probed, [HelperFamily::Launch]);
    // The launch probe fails too: the family itself is lost, and only that family.
    assert_eq!(
        reprobe_families([true; 3], launch_denied, false, |family| family
            != HelperFamily::Launch),
        [false, true, true]
    );
}

#[test]
fn a_failed_family_recovers_on_its_retry_while_the_helper_lives() {
    let mut probed = Vec::new();
    let unchanged = reprobe_families(
        [false, true, true],
        |_| false,
        false,
        |family| {
            probed.push(family);
            true
        },
    );
    assert_eq!((unchanged, probed.len()), ([false, true, true], 0));
    assert_eq!(
        reprobe_families([false, true, true], |_| false, true, |_| true),
        [true; 3]
    );
}
