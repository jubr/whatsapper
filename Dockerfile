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
RUN chmod +x /workspace/docker/entrypoint.sh && \
    for attempt in 1 2 3 4; do \
      npm install && break; \
      [ "$attempt" -eq 4 ] && exit 1; \
      echo "npm install failed (attempt ${attempt}/4), retrying..." >&2; \
      sleep $((attempt * 3)); \
    done && \
    if [ -n "$WWEBJS_REF" ]; then \
      for attempt in 1 2 3 4; do \
        npm install --no-save "github:pedroslopez/whatsapp-web.js#$WWEBJS_REF" && break; \
        [ "$attempt" -eq 4 ] && exit 1; \
        echo "npm install (whatsapp-web.js ref) failed (attempt ${attempt}/4), retrying..." >&2; \
        sleep $((attempt * 3)); \
      done; \
    fi

ENV HA_CUSTOM_COMPONENTS_PATH=/homeassistant/custom_components
ENV WWEBJS_BUILD_REF=${WWEBJS_REF}
ENV APP_BUILD_VERSION=${APP_BUILD_VERSION}
ENV APP_RUNTIME_NAME=${APP_RUNTIME_NAME}
ENV APP_PORT=${APP_PORT}
EXPOSE 3000
EXPOSE 3001

VOLUME /data

ENTRYPOINT ["/workspace/docker/entrypoint.sh"]
