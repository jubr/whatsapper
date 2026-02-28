FROM zenika/alpine-chrome:124-with-puppeteer

ARG WWEBJS_REF=""

ADD app /workspace/app
ADD homeassistant /workspace/homeassistant
COPY docker/entrypoint.sh /workspace/docker/entrypoint.sh
WORKDIR /workspace
USER root
COPY package*.json .
RUN chmod +x /workspace/docker/entrypoint.sh && npm install && \
    if [ -n "$WWEBJS_REF" ]; then npm install --no-save "github:pedroslopez/whatsapp-web.js#$WWEBJS_REF"; fi

ENV HA_CUSTOM_COMPONENTS_PATH=/ha-custom-components
ENV WWEBJS_BUILD_REF=${WWEBJS_REF}
EXPOSE 3000

VOLUME /data
VOLUME /ha-custom-components

ENTRYPOINT ["/workspace/docker/entrypoint.sh"]
