use morphz_coding_eval_v3::{Policy, PolicyService};

#[test]
fn accepted_update_invalidates_the_warm_value() {
    let mut service = PolicyService::default();
    assert!(service.upsert(Policy::new("alpha", "v1", 1)));
    assert_eq!(service.read("alpha").unwrap().value, "v1");

    assert!(service.upsert(Policy::new("alpha", "v2", 2)));
    assert_eq!(service.read("alpha").unwrap().value, "v2");
}

#[test]
fn accepted_delete_does_not_leave_a_ghost_value() {
    let mut service = PolicyService::default();
    assert!(service.upsert(Policy::new("alpha", "v1", 1)));
    assert!(service.read("alpha").is_some());

    assert!(service.delete("alpha", 1));
    assert!(service.read("alpha").is_none());
}

#[test]
fn rejected_stale_update_does_not_replace_the_current_policy() {
    let mut service = PolicyService::default();
    assert!(service.upsert(Policy::new("alpha", "v2", 2)));
    assert!(!service.upsert(Policy::new("alpha", "stale", 1)));

    assert_eq!(service.read("alpha").unwrap().value, "v2");
}
