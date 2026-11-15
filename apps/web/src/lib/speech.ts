const SPEECH_LANG = 'es-MX';

export const speechAvailable = (): boolean => typeof window !== 'undefined' && 'speechSynthesis' in window;

/** Browsers only allow speech after a user gesture: call once from the "Activar sonido" click. */
export function speak(text: string): void {
  if (!speechAvailable()) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = SPEECH_LANG;
  const voice = window.speechSynthesis.getVoices().find((v) => v.lang === SPEECH_LANG);
  if (voice !== undefined) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
}

/** `day` names the slot's day when it is not today's. */
export function paymentAnnouncement(time: string, day: string | null = null): string {
  return day === null ? `Anticipo recibido, cita de las ${time}` : `Anticipo recibido, cita del ${day} a las ${time}`;
}
