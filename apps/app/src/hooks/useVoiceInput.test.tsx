// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appToast } from "@/components/ui/app-toast";
import { useVoiceInput } from "./useVoiceInput";

vi.mock("@/components/ui/app-toast", () => ({ appToast: { error: vi.fn() } }));
vi.mock("@/lib/audio-input-device-preference", () => ({
  useAudioInputDevicePreferenceValue: () => null,
  buildAudioInputConstraints: () => ({ audio: true }),
}));

class Recorder {
  static isTypeSupported = () => true;
  mimeType = "audio/webm";
  state = "inactive";
  onstart = () => {};
  ondataavailable = (_event: { data: Blob }) => {};
  onstop = async () => {};
  start() {
    this.state = "recording";
    this.onstart();
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable({ data: new Blob(["recorded audio"]) });
    return this.onstop();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi
        .fn()
        .mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("starts one recording while microphone access is pending", async () => {
  let grantMicrophone!: (stream: MediaStream) => void;
  const microphoneRequest = new Promise<MediaStream>((resolve) => {
    grantMicrophone = resolve;
  });
  const getUserMedia = vi.fn().mockReturnValue(microphoneRequest);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const stream = {
    getTracks: () => [{ stop: vi.fn() }],
  } as unknown as MediaStream;
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: vi.fn(), onTranscript: vi.fn() }),
  );

  let firstStart!: Promise<void>;
  await act(async () => {
    firstStart = result.current.start();
    await result.current.start();
  });
  expect(getUserMedia).toHaveBeenCalledTimes(1);

  await act(async () => {
    grantMicrophone(stream);
    await firstStart;
  });
  expect(result.current.state).toBe("recording");
});

it("releases a microphone granted after the prompt unmounts", async () => {
  let grantMicrophone!: (stream: MediaStream) => void;
  const microphoneRequest = new Promise<MediaStream>((resolve) => {
    grantMicrophone = resolve;
  });
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn().mockReturnValue(microphoneRequest) },
  });
  const stopTrack = vi.fn();
  const stream = {
    getTracks: () => [{ stop: stopTrack }],
  } as unknown as MediaStream;
  const { result, unmount } = renderHook(() =>
    useVoiceInput({ onTranscribe: vi.fn(), onTranscript: vi.fn() }),
  );

  let start!: Promise<void>;
  await act(async () => {
    start = result.current.start();
  });
  unmount();
  await act(async () => {
    grantMicrophone(stream);
    await start;
  });
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(appToast.error).not.toHaveBeenCalled();
});

it.each([
  new Error("Upload failed"),
  new Error("Audio file exceeds the 20MB limit"),
])("keeps failed audio downloadable after unmount: %s", async (error) => {
  const transcribe = vi.fn().mockRejectedValue(error);
  const transcript = vi.fn();
  const { result, unmount } = renderHook(() =>
    useVoiceInput({
      onTranscribe: transcribe,
      onTranscript: transcript,
    }),
  );
  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());
  expect(result.current.state).toBe("error");
  expect(transcript).not.toHaveBeenCalled();
  const options = vi.mocked(appToast.error).mock.calls[0]?.[1];
  expect(options?.duration).toBe(Infinity);
  expect(options?.action?.label).toBe("Retry transcription");
  expect(options?.cancel?.label).toBe("Download recording");
  unmount();
  const createObjectURL = vi.fn(() => "blob:recording");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  let downloadedName = "";
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloadedName = this.download;
    expect(this.href).toBe("blob:recording");
    expect(this.isConnected).toBe(true);
  });
  if (!options?.cancel) throw new Error("Missing download action");
  const button = render(
    <button onClick={options.cancel.onClick}>Download recording</button>,
  );
  fireEvent.click(button.getByRole("button"));
  expect(createObjectURL).toHaveBeenCalledWith(
    transcribe.mock.calls[0]?.[0].file,
  );
  expect(downloadedName).toBe("recording.webm");
  expect(revokeObjectURL).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:recording");
});

it("retries transcription using the captured recording", async () => {
  const transcribe = vi
    .fn()
    .mockRejectedValueOnce(new Error("Transcription timed out"))
    .mockResolvedValueOnce("Hello again");
  const onTranscript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript }),
  );
  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());

  const retry = vi.mocked(appToast.error).mock.calls[0]?.[1]?.action;
  if (!retry) throw new Error("Missing retry action");
  const button = render(
    <button onClick={retry.onClick}>Retry transcription</button>,
  );
  await act(async () => {
    fireEvent.click(button.getByRole("button"));
  });

  expect(transcribe).toHaveBeenCalledTimes(2);
  expect(transcribe.mock.calls[1]?.[0].file).toBe(
    transcribe.mock.calls[0]?.[0].file,
  );
  expect(onTranscript).toHaveBeenCalledWith("Hello again");
  expect(result.current.state).toBe("idle");
});

it("does not offer a download after explicit cancellation", async () => {
  const { result } = renderHook(() =>
    useVoiceInput({
      onTranscribe: vi
        .fn()
        .mockRejectedValue(new DOMException("Cancelled", "AbortError")),
      onTranscript: vi.fn(),
    }),
  );
  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  await act(async () => result.current.stop());
  expect(result.current.state).toBe("idle");
  expect(appToast.error).not.toHaveBeenCalled();
});

it("stops waiting for a hung transcription and retries the same recording", async () => {
  const transcribe = vi
    .fn()
    .mockImplementationOnce(() => new Promise<string>(() => {}))
    .mockResolvedValueOnce("Recovered dictation");
  const onTranscript = vi.fn();
  const { result } = renderHook(() =>
    useVoiceInput({ onTranscribe: transcribe, onTranscript }),
  );
  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  act(() => result.current.stop());
  expect(result.current.state).toBe("transcribing");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90_000);
  });
  expect(result.current.state).toBe("error");
  expect(transcribe.mock.calls[0]?.[0].signal.aborted).toBe(true);
  const options = vi.mocked(appToast.error).mock.calls[0]?.[1];
  expect(options?.description).toContain("recording is saved");
  if (!options?.action) throw new Error("Missing retry action");
  const retryButton = render(
    <button onClick={options.action.onClick}>Retry transcription</button>,
  );
  await act(async () => {
    fireEvent.click(retryButton.getByRole("button"));
  });
  expect(transcribe.mock.calls[1]?.[0].file).toBe(
    transcribe.mock.calls[0]?.[0].file,
  );
  expect(onTranscript).toHaveBeenCalledWith("Recovered dictation");
  expect(result.current.state).toBe("idle");
});

it("cancels a hung transcription immediately without a later timeout error", async () => {
  const { result } = renderHook(() =>
    useVoiceInput({
      onTranscribe: () => new Promise<string>(() => {}),
      onTranscript: vi.fn(),
    }),
  );
  await act(() => result.current.start());
  vi.advanceTimersByTime(1500);
  act(() => result.current.stop());
  await act(async () => result.current.cancel());
  expect(result.current.state).toBe("idle");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(90_000);
  });
  expect(appToast.error).not.toHaveBeenCalled();
});
