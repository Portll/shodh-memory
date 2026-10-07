//! A record in the retired field-level format is decrypted with the legacy key and
//! re-sealed under the keystore by the read that finds it; without the key it is an
//! error, never ciphertext returned as the memory's text.

use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, KeyInit};
use base64::Engine;
use shodh_memory::memory::storage::MemoryStorage;
use shodh_memory::memory::types::{Experience, ExperienceType, Memory, MemoryId};
use tempfile::TempDir;
use uuid::Uuid;

const PASSPHRASE: &str = "legacy-migration-correct-horse-battery-staple-Q7";
const LEGACY_KEY: [u8; 32] = [0x5a; 32];
const SECRET: &str = "legacy-field-encrypted-distinctive-plaintext-do-not-leak-Q7";

fn legacy_sealed(plain: &str) -> String {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&LEGACY_KEY));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let mut out = b"ENC\x00".to_vec();
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&cipher.encrypt(&nonce, plain.as_bytes()).unwrap());
    base64::engine::general_purpose::STANDARD.encode(out)
}

fn plant(storage: &MemoryStorage, id: &MemoryId, content: String) {
    let experience = Experience {
        experience_type: ExperienceType::Observation,
        content,
        ..Default::default()
    };
    let memory = Memory::new(id.clone(), experience, 0.5, None, None, None, None);
    // Written raw, as the retired encoder left it: a plaintext SHO record whose
    // content field holds the field-level ciphertext.
    let bytes = shodh_memory::serialization::encode_sho(&memory).unwrap();
    storage.db().put(id.0.as_bytes(), bytes).unwrap();
}

fn raw_record(db_path: &std::path::Path, id: &MemoryId) -> Vec<u8> {
    let opts = rocksdb::Options::default();
    let cfs = rocksdb::DB::list_cf(&opts, db_path).unwrap();
    let db = rocksdb::DB::open_cf_for_read_only(&opts, db_path, &cfs, false).unwrap();
    db.get(id.0.as_bytes()).unwrap().expect("record on disk")
}

#[test]
fn a_legacy_record_is_resealed_on_read_and_refused_without_its_key() {
    std::env::set_var("SHODH_MASTER_PASSPHRASE", PASSPHRASE);
    std::env::set_var("SHODH_ENCRYPTION_KEY", hex::encode(LEGACY_KEY));

    let temp = TempDir::new().unwrap();
    let migrated = MemoryId(Uuid::new_v4());
    let orphan = MemoryId(Uuid::new_v4());
    {
        let storage = MemoryStorage::new(temp.path(), None).expect("open with keystore");
        assert!(shodh_memory::memory::storage::encryption_active());
        plant(&storage, &migrated, legacy_sealed(SECRET));

        let read = storage
            .get(&migrated)
            .expect("a legacy record opens with its key");
        assert_eq!(read.experience.content, SECRET);

        std::env::remove_var("SHODH_ENCRYPTION_KEY");
        plant(&storage, &orphan, legacy_sealed(SECRET));
        let err = storage
            .get(&orphan)
            .expect_err("legacy content with no key must not read as text");
        assert!(
            format!("{err:#}").contains("SHODH_ENCRYPTION_KEY is unset"),
            "the refusal names what is missing: {err:#}"
        );
        assert_eq!(
            storage
                .get(&migrated)
                .expect("re-sealed")
                .experience
                .content,
            SECRET,
            "the migrated record no longer needs the legacy key"
        );
    }

    let raw = raw_record(&temp.path().join("storage"), &migrated);
    assert!(
        shodh_memory::keystore::is_encrypted_record(&raw),
        "the read re-sealed the record under the keystore"
    );
    assert!(!raw.windows(SECRET.len()).any(|w| w == SECRET.as_bytes()));
    std::env::remove_var("SHODH_MASTER_PASSPHRASE");
}
