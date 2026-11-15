export const CAMERA_ERROR = {
  denied: 'denied',
  missing: 'missing',
  insecure: 'insecure',
  failed: 'failed',
} as const;

export type CameraError = (typeof CAMERA_ERROR)[keyof typeof CAMERA_ERROR];

export interface QrScan {
  readonly stop: () => void;
}

const REAR_CAMERA: MediaStreamConstraints = { video: { facingMode: 'environment' }, audio: false };
const SCAN_INTERVAL_MS = 250;

class CameraUnavailable extends Error {
  constructor(readonly reason: CameraError) {
    super(`camera unavailable: ${reason}`);
  }
}

/** Asks for the rear camera (any camera where there is none); rejects when it cannot be opened. */
export async function openRearCamera(): Promise<MediaStream> {
  if (window.isSecureContext !== true) throw new CameraUnavailable(CAMERA_ERROR.insecure);
  const devices: MediaDevices | undefined = navigator.mediaDevices;
  if (devices?.getUserMedia === undefined) throw new CameraUnavailable(CAMERA_ERROR.missing);
  return devices.getUserMedia(REAR_CAMERA);
}

export function stopCamera(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function errorName(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : null;
}

/** Why the camera could not be opened or kept scanning, for the owner. */
export function cameraErrorOf(error: unknown): CameraError {
  if (error instanceof CameraUnavailable) return error.reason;
  switch (errorName(error)) {
    case 'NotAllowedError':
    case 'SecurityError':
      return CAMERA_ERROR.denied;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return CAMERA_ERROR.missing;
    default:
      return CAMERA_ERROR.failed;
  }
}

/**
 * Previews `stream` in `video` and reports the text of every QR code seen until stopped.
 * The decoder is loaded here, on first use, so it stays out of the main bundle.
 * `onFailure` reports an error that ended the scan loop (frames without a readable code never do).
 */
export async function scanQrCodes(
  stream: MediaStream,
  video: HTMLVideoElement,
  onCode: (text: string) => void,
  onFailure: (error: unknown) => void,
): Promise<QrScan> {
  const { BrowserQRCodeReader, ChecksumException, FormatException, NotFoundException } = await import('./qr-decoder');
  const isUnreadableFrame = (error: unknown): boolean =>
    error instanceof NotFoundException || error instanceof ChecksumException || error instanceof FormatException;
  const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: SCAN_INTERVAL_MS });
  const controls = await reader.decodeFromStream(stream, video, (result, error) => {
    if (result !== undefined) onCode(result.getText());
    else if (error !== undefined && !isUnreadableFrame(error)) onFailure(error);
  });
  return { stop: () => controls.stop() };
}
