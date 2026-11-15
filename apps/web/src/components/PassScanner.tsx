import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { scannedPassToken, typedPassToken } from '../lib/pass-code';
import { cameraErrorOf, openRearCamera, scanQrCodes, stopCamera, type CameraError, type QrScan } from '../lib/qr-scan';
import { ErrorNote } from './Screen';
import { Button } from './ui/Button';
import { Field, TextInput } from './ui/Field';

export const NOT_A_PASS = 'Este código no es un pase de Pialy.';

const CAMERA_ERROR_TEXT: Record<CameraError, string> = {
  denied: 'Permite el acceso a la cámara para escanear.',
  missing: 'No encontramos una cámara en este dispositivo.',
  insecure: 'La cámara solo funciona en una conexión segura (https).',
  failed: 'No pudimos abrir la cámara. Cierra otras apps que la estén usando y vuelve a intentarlo.',
  reader: 'No pudimos cargar el lector. Revisa tu conexión o escribe el código.',
};

const CAMERA = { starting: 'starting', live: 'live', error: 'error' } as const;

type Camera =
  | { readonly kind: typeof CAMERA.starting }
  | { readonly kind: typeof CAMERA.live }
  | { readonly kind: typeof CAMERA.error; readonly error: CameraError };

const STARTING: Camera = { kind: CAMERA.starting };
const LIVE: Camera = { kind: CAMERA.live };

interface PassScannerProps {
  /** A valid pass was scanned or typed; the camera is already off. */
  readonly onPass: (token: string) => void;
  readonly onClose: () => void;
}

/** The body of the "Escanear pase" sheet: mount it only while the sheet is open, the camera lives with it. */
export function PassScanner({ onPass, onClose }: PassScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopRef = useRef<() => void>(() => undefined);
  const acceptedRef = useRef(false);
  const [camera, setCamera] = useState<Camera>(STARTING);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);

  function accept(token: string) {
    if (acceptedRef.current) return;
    acceptedRef.current = true;
    stopRef.current();
    onPass(token);
  }

  const onScanned = useEffectEvent((text: string) => {
    const token = scannedPassToken(text, window.location.origin);
    if (token === null) setNotice(NOT_A_PASS);
    else accept(token);
  });

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    let active = true;
    let stream: MediaStream | null = null;
    let scan: QrScan | null = null;
    const release = () => {
      scan?.stop();
      if (stream !== null) stopCamera(stream);
    };
    const stop = () => {
      active = false;
      release();
    };
    const fail = (error: unknown) => {
      if (!active) return;
      stop();
      setCamera({ kind: CAMERA.error, error: cameraErrorOf(error) });
    };
    stopRef.current = stop;

    async function start(target: HTMLVideoElement) {
      stream = await openRearCamera();
      const onCode = (text: string) => {
        if (active) onScanned(text);
      };
      if (active) scan = await scanQrCodes(stream, target, onCode, fail);
      if (active) setCamera(LIVE);
      else release();
    }
    start(video).catch(fail);
    return stop;
  }, []);

  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = typedPassToken(code, window.location.origin);
    if (token === null) setCodeError(NOT_A_PASS);
    else accept(token);
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-2xl font-extrabold">Escanear pase</h2>
        <button
          type="button"
          onClick={onClose}
          className="-my-2 -mr-2 inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center px-2 font-bold underline underline-offset-2"
        >
          Cerrar
        </button>
      </div>

      {camera.kind === CAMERA.error ? (
        <ErrorNote>{CAMERA_ERROR_TEXT[camera.error]}</ErrorNote>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">Apunta la cámara al QR del pase del cliente.</p>
          <div className="relative mx-auto mt-3 aspect-square w-full max-w-80 overflow-hidden rounded-sm border-2 border-ink bg-ink">
            <video ref={videoRef} muted playsInline autoPlay aria-hidden="true" className="size-full object-cover" />
            <span aria-hidden="true" className="pointer-events-none absolute inset-[14%] rounded-sm border-2 border-paper" />
            {camera.kind === CAMERA.starting ? (
              <p role="status" className="absolute inset-0 grid place-items-center font-bold text-paper">
                Abriendo cámara…
              </p>
            ) : null}
          </div>
          {notice === null ? null : <ErrorNote>{notice}</ErrorNote>}
        </>
      )}

      <form onSubmit={submitCode} noValidate>
        <Field label="¿No lee el código? Escribe el código del pase" error={codeError}>
          {({ inputId, describedBy }) => (
            <TextInput
              id={inputId}
              aria-describedby={describedBy}
              aria-invalid={codeError === null ? undefined : true}
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                setCodeError(null);
              }}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
            />
          )}
        </Field>
        <Button type="submit" size="md" className="mt-3" disabled={code.trim() === ''}>
          Verificar pase
        </Button>
      </form>
    </>
  );
}
