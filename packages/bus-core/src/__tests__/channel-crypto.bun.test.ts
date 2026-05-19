/**
 * Unit tests for DirectChannel cryptographic utilities.
 *
 * Uses dynamic import() so that Node's Web Crypto initialisation is complete
 * before the module is loaded.
 */

import { describe, it, expect } from 'bun:test';

describe('channel crypto', () => {
  it('generates ECDH keypair', async () => {
    const { generateKeyPair } = await import('../channel/crypto.js');
    const { publicKey, privateKey } = await generateKeyPair();
    expect(publicKey).toBeDefined();
    expect(privateKey).toBeDefined();
  });

  it('exports and imports public key round-trip', async () => {
    const { generateKeyPair, exportPublicKey, importPublicKey } = await import('../channel/crypto.js');
    const { publicKey } = await generateKeyPair();
    const exported = await exportPublicKey(publicKey);
    expect(typeof exported).toBe('string');
    const imported = await importPublicKey(exported);
    expect(imported).toBeDefined();
  });

  it('derives identical shared keys from both sides', async () => {
    const { generateKeyPair, deriveSharedKey, encrypt, decrypt } = await import('../channel/crypto.js');

    // Simulate two peers
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();

    // Both derive the same shared secret
    const aliceKey = await deriveSharedKey(alice.privateKey, bob.publicKey);
    const bobKey = await deriveSharedKey(bob.privateKey, alice.publicKey);

    // Verify: Alice encrypts, Bob decrypts
    const plaintext = JSON.stringify({ secret: 'hello world', count: 42 });
    const encrypted = await encrypt(aliceKey, plaintext);
    const decrypted = await decrypt(bobKey, encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypted payload has opaque iv and data fields', async () => {
    const { generateKeyPair, deriveSharedKey, encrypt } = await import('../channel/crypto.js');
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const key = await deriveSharedKey(alice.privateKey, bob.publicKey);

    const encrypted = await encrypt(key, 'sensitive data');
    expect(encrypted).toHaveProperty('iv');
    expect(encrypted).toHaveProperty('data');
    expect(typeof encrypted.iv).toBe('string');
    expect(typeof encrypted.data).toBe('string');
    // Should not contain plaintext
    expect(encrypted.data).not.toContain('sensitive');
  });

  it('different IVs per encryption', async () => {
    const { generateKeyPair, deriveSharedKey, encrypt } = await import('../channel/crypto.js');
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const key = await deriveSharedKey(alice.privateKey, bob.publicKey);

    const e1 = await encrypt(key, 'same message');
    const e2 = await encrypt(key, 'same message');
    expect(e1.iv).not.toBe(e2.iv);
  });

  it('decrypt with wrong key fails', async () => {
    const { generateKeyPair, deriveSharedKey, encrypt, decrypt } = await import('../channel/crypto.js');
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const carol = await generateKeyPair();

    const aliceKey = await deriveSharedKey(alice.privateKey, bob.publicKey);
    const carolKey = await deriveSharedKey(carol.privateKey, bob.publicKey);

    const encrypted = await encrypt(aliceKey, 'secret');
    await expect(decrypt(carolKey, encrypted)).rejects.toThrow();
  });

  it('handles empty string', async () => {
    const { generateKeyPair, deriveSharedKey, encrypt, decrypt } = await import('../channel/crypto.js');
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const key = await deriveSharedKey(alice.privateKey, bob.publicKey);

    const encrypted = await encrypt(key, '');
    const decrypted = await decrypt(key, encrypted);
    expect(decrypted).toBe('');
  });

  it('handles large payloads', async () => {
    const { generateKeyPair, deriveSharedKey, encrypt, decrypt } = await import('../channel/crypto.js');
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const key = await deriveSharedKey(alice.privateKey, bob.publicKey);

    const large = 'x'.repeat(100_000);
    const encrypted = await encrypt(key, large);
    const decrypted = await decrypt(key, encrypted);
    expect(decrypted).toBe(large);
  });

  it('encrypt with AAD + decrypt with same AAD succeeds', async () => {
    const { generateKeyPair, deriveSharedKey, encrypt, decrypt } = await import('../channel/crypto.js');
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const key = await deriveSharedKey(alice.privateKey, bob.publicKey);
    const aad = 'channel-abc:credential.get:req';

    const plaintext = JSON.stringify({ configId: 'cfg-1' });
    const encrypted = await encrypt(key, plaintext, aad);
    const decrypted = await decrypt(key, encrypted, aad);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypt with AAD + decrypt with different AAD fails', async () => {
    const { generateKeyPair, deriveSharedKey, encrypt, decrypt } = await import('../channel/crypto.js');
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const key = await deriveSharedKey(alice.privateKey, bob.publicKey);

    const encrypted = await encrypt(key, 'payload', 'channel-abc:credential.get:req');
    // Direction mismatch: req vs res — must fail authentication tag verification.
    await expect(decrypt(key, encrypted, 'channel-abc:credential.get:res')).rejects.toThrow();
  });

  it('encrypt with AAD + decrypt without AAD fails', async () => {
    const { generateKeyPair, deriveSharedKey, encrypt, decrypt } = await import('../channel/crypto.js');
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();
    const key = await deriveSharedKey(alice.privateKey, bob.publicKey);

    const encrypted = await encrypt(key, 'payload', 'channel-abc:credential.get:req');
    // AAD was bound during encryption — omitting it on decrypt must fail.
    await expect(decrypt(key, encrypted)).rejects.toThrow();
  });
});
