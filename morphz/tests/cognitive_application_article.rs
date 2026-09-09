use morphz::harness_package::HarnessPackage;
use morphz::sexpr_eval::{self, AllowList, EvaluationOwner};
use morphz::tool::{ReadFileTool, Registry};
use std::sync::Arc;

const PACKAGE: &str = include_str!("../../website/public/examples/file-review.hns");

#[test]
fn article_package_loads_and_validates_without_running_tools_or_a_model() {
    let package = HarnessPackage::from_source("file-review.hns", PACKAGE).unwrap();
    assert_eq!(package.manifest.id, "file-review");
    assert_eq!(package.manifest.version, "1.0.0");
    assert_eq!(package.manifest.tools, vec!["read"]);
    assert_eq!(package.entry.owner, EvaluationOwner::Runtime);
    let registry = Registry::new();
    registry.register(Arc::new(ReadFileTool::default()));
    sexpr_eval::validate(&package.entry.source, &registry, &AllowList::new(["read"]))
        .expect("article example must pass the actual typed program validator");
}

#[test]
fn both_articles_include_the_exact_downloadable_package() {
    for source in [
        include_str!("../../website/content/blog/zh/cognitive-applications.md"),
        include_str!("../../website/content/blog/en/cognitive-applications.md"),
    ] {
        let example = source
            .split_once("```lisp\n")
            .unwrap()
            .1
            .split_once("\n```")
            .unwrap()
            .0;
        assert_eq!(example, PACKAGE.trim_end());
    }
}
