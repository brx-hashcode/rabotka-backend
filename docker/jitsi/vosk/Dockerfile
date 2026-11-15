# Vosk with the small French model, for the call's captions.
# The large model (alphacep/kaldi-fr) takes 3+ GB of RAM: too much next to
# Jitsi on a 6 GB server. This one loads in ~300 MB, at some cost in accuracy.
# Both the server image and the model are pinned (digest, sha256).
FROM alphacep/kaldi-vosk-server@sha256:381024347b954835c9c20adea2041377e7b55f50d4c5887eb42101bbf6e750a1

ARG MODEL=vosk-model-small-fr-0.22
ARG MODEL_SHA256=cabf6180e177eb9b3a9a9d43a437bd5e549f3a7d09525e5d69a3fed787be12ad

RUN cd /opt \
  && wget -q "https://alphacephei.com/vosk/models/${MODEL}.zip" \
  && echo "${MODEL_SHA256}  ${MODEL}.zip" | sha256sum -c - \
  && unzip -q "${MODEL}.zip" \
  && mv "${MODEL}" /opt/vosk-model \
  && rm "${MODEL}.zip"

EXPOSE 2700
WORKDIR /opt/vosk-server/websocket
CMD ["python3", "./asr_server.py", "/opt/vosk-model"]
