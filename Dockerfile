FROM zenika/alpine-chrome:124-with-puppeteer

ARG WWEBJS_REF=""
ARG APP_BUILD_VERSION=""
ARG APP_RUNTIME_NAME=""
ARG APP_PORT=""

ADD app /workspace/app
ADD homeassistant /workspace/homeassistant
COPY docker/entrypoint.sh /workspace/docker/entrypoint.sh
WORKDIR /workspace
USER root
COPY package*.json .
RUN chmod +x /workspace/docker/entrypoint.sh && npm install && \
    if [ -n "$WWEBJS_REF" ]; then npm install --no-save "github:pedroslopez/whatsapp-web.js#$WWEBJS_REF"; fi

ENV HA_CUSTOM_COMPONENTS_PATH=/homeassistant/custom_components
ENV WWEBJS_BUILD_REF=${WWEBJS_REF}
ENV APP_BUILD_VERSION=${APP_BUILD_VERSION}
ENV APP_RUNTIME_NAME=${APP_RUNTIME_NAME}
ENV APP_PORT=${APP_PORT}
EXPOSE 3000
EXPOSE 3001

VOLUME /data

ENTRYPOINT ["/workspace/docker/entrypoint.sh"]
