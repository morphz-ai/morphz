//! Generate mechanical forwarding from the actual RuntimeStore trait graph.
//! Adding a trait/method cannot silently leave the remote backend incomplete.
use quote::quote;
use std::collections::{BTreeMap, BTreeSet};
use syn::{FnArg, Item, Pat, TraitItem, TypeParamBound};

pub fn generate() {
    let mut traits = BTreeMap::new();
    for path in ["src/memory/mod.rs", "src/scheduler/store.rs"] {
        println!("cargo:rerun-if-changed={path}");
        let source = std::fs::read_to_string(path).expect("read RuntimeStore traits");
        for item in syn::parse_file(&source)
            .expect("parse RuntimeStore traits")
            .items
        {
            if let Item::Trait(item) = item {
                traits.insert(item.ident.to_string(), item);
            }
        }
    }
    let mut pending = vec!["RuntimeStore".to_owned()];
    let mut visited = BTreeSet::new();
    let mut implementations = Vec::new();
    let mut operation_names = Vec::new();
    while let Some(name) = pending.pop() {
        if !visited.insert(name.clone()) {
            continue;
        }
        let item = traits
            .get(&name)
            .expect("RuntimeStore supertrait is declared");
        for bound in &item.supertraits {
            if let TypeParamBound::Trait(bound) = bound {
                let name = bound.path.segments.last().unwrap().ident.to_string();
                if name != "Send" && name != "Sync" {
                    pending.push(name);
                }
            }
        }
        let name = &item.ident;
        let mut methods = Vec::new();
        for method in &item.items {
            let TraitItem::Fn(method) = method else {
                panic!("unsupported RuntimeStore associated item");
            };
            let signature = &method.sig;
            let method_name = &signature.ident;
            let body = match method_name.to_string().as_str() {
                "worker_coordination_mode" => quote! { WorkerCoordinationMode::SharedLeases },
                "storage_pool_metrics" => quote! { None },
                "storage_backend_name" => quote! { "remote" },
                // A notification wait is a hint, not a Store operation. Never
                // hold the transaction queue or obstruct owner renewal here.
                "wait_for_edge_command_change" | "wait_for_thread_signal_change" => {
                    quote! { tokio::time::sleep(timeout).await }
                }
                _ => {
                    assert!(
                        signature.asyncness.is_some(),
                        "new synchronous Store method needs an explicit remote contract"
                    );
                    let args: Vec<_> = signature
                        .inputs
                        .iter()
                        .filter_map(|argument| match argument {
                            FnArg::Receiver(_) => None,
                            FnArg::Typed(argument) => match &*argument.pat {
                                Pat::Ident(pattern) => Some(&pattern.ident),
                                _ => panic!("Store arguments must have names"),
                            },
                        })
                        .collect();
                    let operation_name = format!("{name}::{method_name}");
                    operation_names.push(operation_name.clone());
                    quote! {
                        self.execute(#operation_name, |store| async move {
                            #name::#method_name(&*store, #(#args),*).await
                        }).await?
                    }
                }
            };
            let attrs: Vec<_> = method
                .attrs
                .iter()
                .filter(|attribute| !attribute.path().is_ident("doc"))
                .collect();
            methods.push(quote! { #(#attrs)* #signature { #body } });
        }
        // SessionStore is a marker with a blanket implementation. Its children
        // are still traversed above; emitting another impl would conflict.
        if methods.is_empty() {
            continue;
        }
        implementations.push(format!(
            "#[async_trait::async_trait]\nimpl {name} for RemoteRuntimeStore {{\n{}\n}}\n",
            methods
                .into_iter()
                .map(|method| method.to_string())
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    let names = quote! { const REMOTE_STORE_OPERATION_NAMES: &[&str] = &[#(#operation_names),*]; };
    std::fs::write(
        std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("remote_store_impls.rs"),
        format!("{names}\n{}", implementations.join("\n")),
    )
    .expect("write remote Store implementations");
}
