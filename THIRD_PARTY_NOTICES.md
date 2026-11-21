# Third-party notices

The root MIT licence applies to original Misty project contributions. It does not replace the following upstream licences.

| Component | Attribution and licence |
| --- | --- |
| Prominence-derived runtime | MIT; original notice retained in `prominence/LICENSE`, snapshot metadata in `prominence/UPSTREAM.json` |
| Cline-derived executors | Apache-2.0; see `tooling/cline/NOTICE.md`, `tooling/cline/vendor/LICENSE` and the pinned upstream manifest |
| Bundled overlay fonts | SIL Open Font License 1.1; individual notices are retained beside each family in `desktop/Misty.Overlay/Assets/Fonts/` |
| JavaScript and Go dependencies | Respective upstream licences and pinned dependency manifests |
| Matrix bridge container images | Respective upstream projects and licences; images are not included in this source distribution |

The Misty avatar and generated notification sound are included with the project owner's approval. The sound-generation source is retained in `scripts/generate-misty-ping.py`.

Vendored Cline files are preserved byte-for-byte. Wrapper and deployment changes are maintained outside that vendor directory.