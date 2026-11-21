# Laptop voice and tab shortcuts

Misty uses Whisper base.en Q5_1 through Whisper.net/whisper.cpp for local dictation, limited to two CPU threads with no GPU. Vosk small en-US 0.15 only proposes inexpensive wake candidates; Whisper independently verifies that the utterance actually begins with Misty before forwarding a wake-triggered request. Microsoft Zira Desktop remains the local SAPI speaking voice. No microphone audio is uploaded; recognised request text goes through the existing private SSH overlay owner-input endpoint to the VM.

## Controls

- Ctrl+Shift+V: start a request, or finish an active recording
- Say "Misty" or "hey Misty": wake locally, then give the request; a continuous wake+request phrase is also supported
- Ctrl+Shift+S: stop speech
- Ctrl+Shift+Space: hide/show, keeping the selected panel and in-memory subview
- Ctrl+Shift+Z: chat
- Ctrl+Shift+Q: Codex
- Ctrl+Shift+A: activity
- Ctrl+Shift+C: VM
- Ctrl+Shift+D: Gmail
- Ctrl+Shift+F: approvals
- Press the same panel shortcut again to collapse that panel

The tray menu controls local wake-word listening, speaking fresh Misty replies, stop speech, and repeating the last spoken reply. A listening request waits for 1.4 seconds of quiet after speech, or finishes after 20 seconds. Quiet/no-speech input is discarded before inference. Unverified wake candidates and low-confidence results are not forwarded. Replies queue while a user request is being captured/decoded instead of cutting off that recording. The keyboard remains available to interrupt speech output.

## Persistence and diagnostics

Hiding/showing no longer collapses the panel. A separate per-user workspace.json saves panel, window bounds, drafts, scroll position, voice settings and hidden state across restarts. Existing state.json and pending send records are preserved.

%LOCALAPPDATA%/Misty/Overlay/voice-status.json records engine availability, registered shortcut IDs and successful synthesis completion counts/hashes, without recording transcripts or raw audio.

The wake candidate model is in %LOCALAPPDATA%/Misty/Voice/vosk-model-small-en-us-0.15. Dictation loads %LOCALAPPDATA%/Misty/Voice/ggml-base.en-q5_1.bin on demand and releases the processor/factory after each request. Source: https://github.com/ggml-org/whisper.cpp and https://alphacephei.com/vosk/models

## Validation

dotnet run --project desktop/Misty.Voice.Tests/Misty.Voice.Tests.csproj -c Release

Checks actual local synthesis to PCM, accurate recognition of the test phrase, microphone initialisation, capture state, and the combined wake phrase/request pipeline without sending synthetic owner inputs.

Native tests additionally exercise false wake candidates, background phrases, empty requests and quiet noise. Run the published single-file test executable too: Whisper native CPU DLLs must be copied beside the executable under runtimes/win-x64, which the project Publish target now does.

The initial small-Vosk implementation had real false wake activations and poor owner speech recognition despite passing its synthetic test. It is superseded by the Whisper implementation. Benchmark details are in stt-benchmark-20261109.md; owner-accent accuracy still needs the deliberate test sentence requested in chat.