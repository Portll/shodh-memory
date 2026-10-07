//! The legacy field-encryption key with no keystore is refused at open: it would mean
//! legacy records read decrypted and every write after them stored in plaintext.

use shodh_memory::memory::storage::MemoryStorage;
use tempfile::TempDir;

#[test]
fn a_legacy_key_without_a_keystore_refuses_to_open() {
    std::env::remove_var("SHODH_MASTER_PASSPHRASE");
    std::env::set_var("SHODH_ENCRYPTION_KEY", hex::encode([0x5a_u8; 32]));
    let temp = TempDir::new().unwrap();
    let err = MemoryStorage::new(temp.path(), None)
        .err()
        .expect("a legacy key alone must refuse");
    assert!(
        format!("{err:#}").contains("no keystore is active"),
        "the refusal says why: {err:#}"
    );
    std::env::remove_var("SHODH_ENCRYPTION_KEY");
}
