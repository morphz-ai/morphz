//! Exercise the real PyTorch reader after the ZIP security dependency update.
//! These tiny upstream fixtures are local; no model or network is required.
use candle_core::pickle::PthTensors;
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../third_party/candle-core-0.10.2/tests")
        .join(name)
}

#[test]
fn pytorch_archive_reads_plain_and_nested_state_dicts() -> candle_core::Result<()> {
    for (file, key) in [
        ("test.pt", None),
        ("test_with_key.pt", Some("model_state_dict")),
    ] {
        let tensors = PthTensors::new(fixture(file), key)?;
        let tensor = tensors.get("test")?.expect("upstream test tensor");
        assert_eq!(tensor.dims(), &[2, 4]);
        assert_eq!(
            tensor.to_vec2::<i64>()?,
            vec![vec![1, 2, 3, 4], vec![5, 6, 7, 8]]
        );
    }
    Ok(())
}

#[test]
fn pytorch_archive_preserves_fortran_tensor_layout() -> candle_core::Result<()> {
    let tensors = PthTensors::new(fixture("fortran_tensor_3d.pth"), None)?;
    let tensor = tensors
        .get("tensor_fortran")?
        .expect("upstream Fortran tensor");
    assert_eq!(tensor.dims(), &[2, 3, 4]);
    assert_eq!(
        tensor.to_vec3::<i64>()?,
        vec![
            vec![vec![1, 2, 3, 4], vec![5, 6, 7, 8], vec![9, 10, 11, 12]],
            vec![
                vec![13, 14, 15, 16],
                vec![17, 18, 19, 20],
                vec![21, 22, 23, 24]
            ],
        ]
    );
    Ok(())
}

#[test]
fn npz_archive_names_and_tensor_values_survive_zip_upgrade() -> candle_core::Result<()> {
    let path = fixture("test.npz");
    let eager = candle_core::Tensor::read_npz(&path)?;
    let lazy = candle_core::npy::NpzTensors::new(&path)?;
    assert_eq!(eager.len(), 2);
    for (name, expected) in [("x", 0..10), ("x_plus_one", 1..11)] {
        let tensor = eager.iter().find(|(key, _)| key == name).unwrap();
        assert_eq!(
            tensor.1.to_vec1::<i64>()?,
            expected.clone().collect::<Vec<_>>()
        );
        assert_eq!(
            lazy.get(name)?.unwrap().to_vec1::<i64>()?,
            expected.collect::<Vec<_>>()
        );
    }
    Ok(())
}
