// Captions in French only: Vosk transcribes, it doesn't translate, so no
// « translate into » languages are offered.
// docker-jitsi-meet appends this file to config.js at start;
// docker-compose.yml mounts it at /config/custom-config.js.
config.transcription.translationEnabled = false;
config.transcription.useAppLanguage = false;
config.transcription.preferredLanguage = 'fr-FR';
