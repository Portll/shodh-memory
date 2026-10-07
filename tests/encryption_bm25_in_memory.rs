//! With a keystore the BM25 index never reaches disk: it would store every memory's
//! content and token positions in plaintext beside the sealed records. An index left
//! there from before encryption is removed when the system opens.

use shodh_memory::memory::{Experience, ExperienceType, MemoryConfig, MemorySystem};
use tempfile::TempDir;

#[test]
fn a_keystore_keeps_the_lexical_index_off_disk() {
    std::env::set_var(
        "SHODH_MASTER_PASSPHRASE",
        "bm25-in-memory-correct-horse-battery-staple-K3",
    );
    let temp = TempDir::new().unwrap();
    let residue = temp.path().join("bm25_index");
    std::fs::create_dir_all(&residue).unwrap();
    std::fs::write(residue.join("meta.json"), b"{}").unwrap();

    let config = MemoryConfig {
        storage_path: temp.path().to_path_buf(),
        working_memory_size: 100,
        session_memory_size_mb: 50,
        max_heap_per_user_mb: 500,
        auto_compress: false,
        compression_age_days: 7,
        importance_threshold: 0.3,
    };
    let system = MemorySystem::new(config, None).expect("open with a keystore");
    assert!(shodh_memory::memory::storage::encryption_active());
    assert!(
        !residue.exists(),
        "the plaintext index left on disk was removed"
    );

    system
        .remember(
            Experience {
                experience_type: ExperienceType::Observation,
                content: "bm25-in-memory distinctive plaintext".to_string(),
                ..Default::default()
            },
            None,
        )
        .expect("remember");
    assert!(
        !residue.exists(),
        "remembering under a keystore wrote no lexical index"
    );
    std::env::remove_var("SHODH_MASTER_PASSPHRASE");
}
