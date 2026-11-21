# Local STT benchmark — 9 November 2026

Hardware: Ryzen 9 8940HX, 16 physical / 32 logical cores, approximately 32 GB RAM, Windows 11. CPU only, two Whisper decoder threads. No cloud speech processing or GPU runtime.

## Synthetic comparison

12 Windows TTS sentences (6 passages, Zira and David), 90 reference words, plus silence and quiet random noise. Each model ran in its own process. WER uses word-level Levenshtein distance after case/punctuation normalisation. This does not measure the owner's accent, microphone acoustics or real-world word error rate.

| Model | Word errors / 90 | Median decode | P95 decode | Peak benchmark process working set |
|---|---:|---:|---:|---:|
| Vosk small en-US 0.15 | 6 | 0.769 s | 1.046 s | 190.1 MiB |
| Whisper base.en Q5_1 | 0 | 1.721 s | 1.789 s | 314.7 MiB |
| Whisper small.en Q5_1 | 1 | 6.081 s | 6.994 s | 542.6 MiB |

Base CPU averaged 6.18% of this 32-logical-CPU machine while decoding, approximately two busy logical cores. These percentages are not percentages of one core. On the raw no-speech controls, base generated one sound label; small generated two. Production capture rejects quiet/no-speech audio before decoding, filters bracketed labels, and independently verifies a spoken wake prefix.

Selected base.en Q5_1 as the provisional speed/memory/accuracy fit. Small was slower and larger without improving this limited synthetic sample.

## Live app observations

Published release: data/deployment/misty-overlay-releases/20261109-095128227. The Whisper processor is loaded on demand, two CPU threads, no context carried between utterances, no GPU. Capture collects the whole utterance until 1.4 seconds of quiet (20 seconds maximum), then performs one decode. Spoken replies defer while recording/decoding.

One actual background candidate containing 7.2 seconds of captured audio decoded in 3.770 s, using 7.406 CPU-seconds (~6.14% of total machine CPU during that operation). It was rejected because Whisper did not verify an addressed wake prefix. Whole-app peak working set reached 612.1 MiB; a later short mixed-activity sample was 392.9 MiB and 0.941% total machine CPU. This is not an idle benchmark or a measured owner-accent accuracy result.

Owner asked to read: "this is a speech test. today is monday and i am speaking naturally into my laptop microphone" using Ctrl+Shift+V. Await that result before claiming real-voice accuracy.

## Files and verification

- Native reports: %LOCALAPPDATA%/Misty/Voice/benchmarks/20261109
- vosk-2threads-041145.json
- base.en-q5_1-2threads-041214.json
- small.en-q5_1-2threads-041437.json
- Runner: desktop/Misty.Speech.Benchmark
- Recognition code: desktop/Misty.Overlay/WhisperTranscriber.cs and LocalVoice.cs
- Packaged tests: data/deployment/voice-tests-20261109-0952/Misty.Voice.Tests.exe

The larger benchmark first exceeded the adapter's 30-second command limit and was confirmed stopped. Its complete result came from a distinct background process with persistent stdout/stderr files; no uncertain command was replayed.

Published single-file tests initially exposed a native-library lookup failure. Project Publish targets now explicitly copy the four CPU DLL sidecars to runtimes/win-x64. Packaged tests then passed actual decoding, wake/request processing, rejection of a forced false wake candidate, and quiet-noise gating. No synthetic owner inputs were sent.

Model hashes verified against the model repository:
- base.en Q5_1 (59,721,011 bytes): 4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f
- small.en Q5_1 (190,098,681 bytes): bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30