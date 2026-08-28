# Voice Mood Fix for Mobile (Android Overlay Issue)

## The Issue
On mobile devices (especially Android), users frequently encountered the error:
> "This site cannot ask for your permission. Close any Bubbles or overlays from other apps. Then try again."

This is a security feature in Android's WebRTC implementation that prevents malicious apps from drawing an invisible overlay (tapjacking) over the browser's permission dialog. When an overlay like Facebook Messenger Chat Heads, Assistive Touch, or Edge panels is active, Chrome completely blocks the microphone permission request and throws a `NotAllowedError`.

## The Solution
We have implemented a **native file input fallback**. 
1. When `startRecording(mode)` invokes `navigator.mediaDevices.getUserMedia({ audio: true })` and it fails due to an overlay or permission issue.
2. The `catch` block detects the `NotAllowedError` or permission-related error string.
3. Instead of simply showing an error toast, the app automatically triggers a hidden `<input type="file" accept="audio/*" capture="microphone">`.
4. This input bypasses the WebRTC permission prompt entirely and opens the mobile device's native voice recorder app.
5. Once the user finishes recording, the `change` event listener catches the `File` object (which is a valid `Blob`), wraps it in a `FormData` object, and sends it to our `/voice` API endpoint exactly as the original `MediaRecorder` logic did.
6. The app then updates the UI to "Thinking..." and displays the transcribed text or sends the voice chat as expected.

## Track the Flow
You can track this fallback flow in `static/app.js`:
- Check the `catch (err)` block inside `async function startRecording(mode)` (around line 1553).
- Notice how it invokes `startNativeRecordingFallback(mode)` upon detecting overlay or permission errors.
- The `startNativeRecordingFallback(mode)` handles dynamic element injection, UI state management, and the `fetch` POST to `/voice`.
