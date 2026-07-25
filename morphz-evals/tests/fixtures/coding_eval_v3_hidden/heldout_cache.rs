use morphz_coding_eval_v3::{Policy, PolicyService};

#[test]
fn accepted_update_invalidates_only_the_target_tenant() {
    let mut service = PolicyService::default();
    assert!(service.upsert(Policy::new("alpha", "a1", 1)));
    assert!(service.upsert(Policy::new("beta", "b1", 1)));
    service.read("alpha");
    service.read("beta");
    service.read("beta");
    let before = service.cache_stats();

    assert!(service.upsert(Policy::new("alpha", "a2", 2)));
    assert_eq!(service.read("beta").unwrap().value, "b1");
    let after = service.cache_stats();

    assert_eq!(after.hits, before.hits + 1);
    assert_eq!(after.invalidations, before.invalidations + 1);
}

#[test]
fn rejected_update_does_not_disturb_a_warm_cache_entry() {
    let mut service = PolicyService::default();
    assert!(service.upsert(Policy::new("alpha", "current", 2)));
    service.read("alpha");
    let before = service.cache_stats();

    assert!(!service.upsert(Policy::new("alpha", "stale", 1)));
    assert_eq!(service.read("alpha").unwrap().value, "current");
    let after = service.cache_stats();

    assert_eq!(after.hits, before.hits + 1);
    assert_eq!(after.invalidations, before.invalidations);
}

#[test]
fn rejected_delete_does_not_disturb_a_warm_cache_entry() {
    let mut service = PolicyService::default();
    assert!(service.upsert(Policy::new("alpha", "current", 2)));
    service.read("alpha");
    let before = service.cache_stats();

    assert!(!service.delete("alpha", 1));
    assert_eq!(service.read("alpha").unwrap().value, "current");
    let after = service.cache_stats();

    assert_eq!(after.hits, before.hits + 1);
    assert_eq!(after.invalidations, before.invalidations);
}

#[test]
fn successful_delete_invalidates_exactly_once() {
    let mut service = PolicyService::default();
    assert!(service.upsert(Policy::new("alpha", "current", 2)));
    service.read("alpha");
    let before = service.cache_stats();

    assert!(service.delete("alpha", 2));
    assert!(service.read("alpha").is_none());
    let after = service.cache_stats();

    assert_eq!(after.invalidations, before.invalidations + 1);
    assert_eq!(after.misses, before.misses + 1);
}
