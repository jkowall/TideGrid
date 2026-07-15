# ADR 0002: Cross-platform native captain client

**Status:** Accepted  
**Date:** 2026-07-15

## Context

Captains require encrypted manifests, predictable offline behavior, secure keys, background sync, and remote revocation.

## Decision

Use React Native with native builds, SQLCipher, Keychain/Keystore, and platform background-task APIs.

## Alternatives

PWA; separate Swift and Kotlin clients.

## Benefits

Native security/storage with shared product code and faster MVP delivery.

## Risks and consequences

Native module upgrades and platform-specific background limits require device testing.

## Revisit when

Field tests show React Native cannot meet offline, encryption, MDM, or background reliability requirements.
